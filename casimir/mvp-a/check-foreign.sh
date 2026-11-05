#!/usr/bin/env bash
# Deliberately leaves the persisted operation blocked and ingress closed.
# Run last, only on the disposable experiment; there is no automatic unblock.
set -euo pipefail
task_container=${CASIMIR_TOOL_CONTAINER:-casimir-mvp-a-tooling}
[[ $(docker inspect --format '{{index .Config.Labels "org.casimir.task"}}' "$task_container") == mvp-a ]]
if docker inspect casimir-mvp-a-foreign-fixture >/dev/null 2>&1; then echo 'Existing fault fixture; refusing replacement.' >&2; exit 1; fi
export CASIMIR_DOCKER_GID=${CASIMIR_DOCKER_GID:-$(stat -c %g /var/run/docker.sock)}
compose=(docker compose -f casimir/mvp-a/compose.yaml)
image=$(docker inspect --format '{{.Image}}' "$(docker ps -q --filter label=org.casimir.task=mvp-a --filter label=org.casimir.role=app)")
CASIMIR_TEST_FAILPOINT=after_old_stop "${compose[@]}" up -d --no-deps --force-recreate executor
docker exec "$task_container" sh -ec 'set -a; . .local/mvp-a/api.env; set +a; node casimir/mvp-a/check-foreign.mjs' &
client_pid=$!
found=false
for ((attempt=0;attempt<240;attempt++)); do
 if docker logs casimir-mvp-a-executor 2>&1 | grep -q 'casimir_failpoint after_old_stop'; then found=true; break; fi
 if ! kill -0 "$client_pid" 2>/dev/null; then wait "$client_pid"; exit 1; fi
 sleep 1
done
[[ $found == true ]]
foreign_id=$(docker run -d --init --name casimir-mvp-a-foreign-fixture --label org.casimir.task=mvp-a --label org.casimir.role=foreign-fixture \
 --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --cpus 0.5 --pids-limit 64 \
 --mount type=volume,source=casimir-mvp-a_appdata,target=/data --entrypoint node "$image" --input-type=module -e \
 'import Database from "/runner/node_modules/better-sqlite3/lib/index.js";const db=new Database("/data/app.sqlite");db.prepare("INSERT INTO messages(text) VALUES(?)").run("foreign writer sentinel");db.close();console.log("foreign_write_complete");setInterval(()=>{},1000);')
for ((attempt=0;attempt<30;attempt++)); do
 if docker logs "$foreign_id" 2>&1 | grep -q foreign_write_complete; then break; fi
 sleep 1
done
docker logs "$foreign_id" 2>&1 | grep -q foreign_write_complete
data_script=$(cat casimir/mvp-a/check-data.mjs)
before=$(docker exec "$foreign_id" node --input-type=module -e "$data_script")
docker kill casimir-mvp-a-executor
CASIMIR_TEST_FAILPOINT= "${compose[@]}" up -d --no-deps --force-recreate executor
wait "$client_pid"
[[ $(docker inspect --format '{{.State.Running}}' "$foreign_id") == true ]]
after=$(docker exec "$foreign_id" node --input-type=module -e "$data_script")
[[ $before == "$after" ]]
[[ $(docker inspect --format '{{index .Config.Labels "org.casimir.role"}}' "$foreign_id") == foreign-fixture ]]
docker stop "$foreign_id"
docker rm "$foreign_id"
echo 'Foreign resource preserved during recovery; exact messages/history/batches/schema unchanged. Only injected fixture removed; operation remains blocked.'
