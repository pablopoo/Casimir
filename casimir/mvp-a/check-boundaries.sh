#!/usr/bin/env bash
set -euo pipefail
app_id=$(docker ps -q --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=app)
[[ -n $app_id && $app_id != *$'\n'* ]]
script=$(cat casimir/mvp-a/check-egress.mjs)
docker exec "$app_id" node --input-type=module -e "$script"
image=$(docker inspect --format '{{.Image}}' "$app_id")
docker run --rm --init --label org.casimir.task=mvp-a --label org.casimir.role=boundary-check \
 --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
 --memory 256m --cpus 0.5 --pids-limit 64 --entrypoint node "$image" --input-type=module -e "$script"
[[ $(docker network inspect --format '{{.Internal}}' casimir-mvp-a_apps) == true ]]
for container in "$app_id" casimir-mvp-a-api; do
 [[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container") == true ]]
 [[ $(docker inspect --format '{{.HostConfig.Privileged}}' "$container") == false ]]
 if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | grep -q docker.sock; then exit 1; fi
 docker inspect --format '{{.Name}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} user={{.Config.User}} mounts={{range .Mounts}}{{.Destination}}:rw={{.RW}},{{end}}' "$container"
done
