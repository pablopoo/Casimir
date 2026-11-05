#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
if [[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$task_container") != mvp-a ]]; then
  echo 'Expected the task-owned tooling container documented in README.' >&2; exit 1
fi
mkdir -p .local/mvp-a
chmod 700 .local/mvp-a
task_image=$(docker inspect --format '{{.Image}}' "$task_container")
# Run credential generation in Docker; no Node/dependencies on the host.
docker run --rm --label org.casimir.task=mvp-a --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD/.local/mvp-a,target=/output" \
  --mount "type=bind,source=$PWD/casimir/mvp-a/init.mjs,target=/init.mjs,readonly" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 64m --cpus 0.25 --pids-limit 32 "$task_image" node /init.mjs /output
docker compose -f casimir/mvp-a/compose.yaml up -d --wait db
if ! docker network inspect casimir-mvp-a_runtime --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | grep -Fxq "$task_container"; then
  docker network connect casimir-mvp-a_runtime "$task_container"
fi
docker exec --user root "$task_container" mkdir -p /src/.local/mvp-a
docker cp .local/mvp-a/. "$task_container":/src/.local/mvp-a/
docker exec --user root "$task_container" chown -R node:node /src/.local/mvp-a
