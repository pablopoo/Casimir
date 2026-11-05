#!/usr/bin/env bash
set -euo pipefail
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
export CASIMIR_DOCKER_GID=${CASIMIR_DOCKER_GID:-$(stat -c %g /var/run/docker.sock)}
compose=(docker compose -f casimir/mvp-a/compose.yaml)
if [[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$task_container") != mvp-a ]]; then exit 1; fi
run_node() {
  docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-recovery.mjs "$@"' sh "$@"
}
for point in ${CASIMIR_RECOVERY_POINTS:-after_old_stop after_sqlite_commit before_gate_open after_gate_open guard_loss}; do
  failpoint=$point
  if [[ $point == guard_loss ]]; then failpoint=after_old_stop; fi
  CASIMIR_TEST_FAILPOINT=$failpoint "${compose[@]}" up -d --no-deps --force-recreate executor
  run_node start "$point" &
  client_pid=$!
  found=false
  for ((attempt=0;attempt<240;attempt++)); do
    if docker logs casimir-mvp-a-executor 2>&1 | grep -q "casimir_failpoint $failpoint"; then found=true; break; fi
    if ! kill -0 "$client_pid" 2>/dev/null; then wait "$client_pid"; exit 1; fi
    sleep 1
  done
  if [[ $found != true ]]; then echo "Failpoint not reached: $point" >&2; exit 1; fi
  run_node observe "$point"
  if [[ $point == guard_loss ]]; then
    run_node lose-guard
    for ((attempt=0;attempt<30;attempt++)); do
      if [[ $(docker inspect --format '{{.State.Running}}' casimir-mvp-a-executor) == false ]]; then break; fi
      sleep 1
    done
    [[ $(docker inspect --format '{{.State.Running}}' casimir-mvp-a-executor) == false ]]
  else
    docker kill casimir-mvp-a-executor
  fi
  CASIMIR_TEST_FAILPOINT= "${compose[@]}" up -d --no-deps --force-recreate executor
  wait "$client_pid"
  for ((attempt=0;attempt<30;attempt++)); do
    count=$(docker ps -aq --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=job | wc -l)
    if [[ $count == 0 ]]; then break; fi
    sleep 1
  done
  [[ $count == 0 ]]
  count=$(docker ps -q --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=app | wc -l)
  [[ $count == 1 ]]
done
run_node snapshot
app_id=$(docker ps -q --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=app)
[[ -n $app_id && $app_id != *$'\n'* ]]
docker restart "$app_id" casimir-mvp-a-db casimir-mvp-a-api casimir-mvp-a-executor
for ((attempt=0;attempt<60;attempt++)); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' casimir-mvp-a-api) == healthy ]]; then break; fi
  sleep 1
done
run_node retained
