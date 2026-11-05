#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
docker info --format '{{.ServerVersion}}' >/dev/null
# Refuse pre-existing resources that do not belong to this experiment.
for resource in database artifacts appdata snapshots routes runtime-secrets jobs; do
  resource_name="casimir-mvp-a_$resource"
  if docker volume inspect "$resource_name" >/dev/null 2>&1; then
    [[ $(docker volume inspect --format '{{index .Labels "org.casimir.task"}}' "$resource_name") == mvp-a ]] || { echo 'Foreign volume; refusing runtime preparation.' >&2; exit 1; }
  fi
done
for resource in db init migrate api executor control-ingress app-ingress; do
  resource_name="casimir-mvp-a-$resource"
  if docker container inspect "$resource_name" >/dev/null 2>&1; then
    [[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$resource_name") == mvp-a ]] || { echo 'Foreign container; refusing runtime preparation.' >&2; exit 1; }
  fi
done
bash casimir/mvp-a/prepare.sh
for resource in runtime apps front; do
  resource_name="casimir-mvp-a_$resource"
  if docker network inspect "$resource_name" >/dev/null 2>&1; then
    [[ $(docker network inspect --format '{{index .Labels "org.casimir.task"}}' "$resource_name") == mvp-a ]] || { echo 'Foreign network; refusing runtime preparation.' >&2; exit 1; }
  fi
done
# Current product source, excluding all private files and local dependencies.
tar --exclude=.git --exclude=.local --exclude=.worktrees --exclude=node_modules --exclude=dist --exclude=.void -cf - . | docker cp - "$task_container":/src/
docker exec "$task_container" node casimir/mvp-a/runtime.mjs
mkdir -p casimir/mvp-a/runner/dist
docker cp "$task_container":/src/casimir/mvp-a/runner/dist/. casimir/mvp-a/runner/dist/
runtime_id=$(sed -n 's/.*"runtimeId":"\([a-f0-9]*\)".*/\1/p' casimir/mvp-a/runner/dist/runtime.json)
[[ $runtime_id =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid runner descriptor.' >&2; exit 1; }
docker build --label org.casimir.task=mvp-a --label "org.casimir.runtime-id=$runtime_id" -t casimir-mvp-a-runner:local casimir/mvp-a/runner
runner_image=$(docker image inspect --format '{{.Id}}' casimir-mvp-a-runner:local)
docker exec -e "CASIMIR_RUNNER_IMAGE=$runner_image" "$task_container" node casimir/mvp-a/configure.mjs
for config in profile.json runner.json runtime-env.json executor.env; do
  docker cp "$task_container":/src/.local/mvp-a/"$config" .local/mvp-a/"$config"
done
docker build --target runtime --label org.casimir.task=mvp-a -f casimir/mvp-a/Dockerfile -t casimir-mvp-a-control:local .
export CASIMIR_DOCKER_GID
CASIMIR_DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f casimir/mvp-a/compose.yaml config --quiet
docker compose -f casimir/mvp-a/compose.yaml up -d --wait control-ingress app-ingress executor
if ! docker network inspect casimir-mvp-a_front --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | grep -Fxq "$task_container"; then
  docker network connect casimir-mvp-a_front "$task_container"
fi
