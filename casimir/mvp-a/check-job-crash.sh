#!/usr/bin/env bash
set -euo pipefail
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
[[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$task_container") == mvp-a ]]
run_node() { docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-job-crash.mjs "$@"' sh "$@"; }
run_node setup
run_node crash &
client_pid=$!
job_id=
for ((attempt=0;attempt<240;attempt++)); do
 job_id=$(docker ps -q --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=job --filter label=org.casimir.action=compatibility)
 if [[ -n $job_id ]]; then break; fi
 if ! kill -0 "$client_pid" 2>/dev/null; then wait "$client_pid"; exit 1; fi
 sleep 1
done
[[ -n $job_id && $job_id != *$'\n'* ]]
[[ $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$job_id") == none ]]
docker inspect --format 'compatibility-job={{.Id}} mounts={{range .Mounts}}{{.Destination}}:rw={{.RW}},{{end}}' "$job_id"
docker kill "$job_id"
wait "$client_pid"
for ((attempt=0;attempt<30;attempt++)); do
 if [[ -z $(docker ps -aq --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=job) ]]; then break; fi
 sleep 1
done
[[ -z $(docker ps -aq --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=job) ]]
