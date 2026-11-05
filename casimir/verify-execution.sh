#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CASIMIR_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
compose=(docker compose -f casimir/execution.compose.yaml)
checks() { "${compose[@]}" exec -T checks "$@"; }
start_executor() { "${compose[@]}" stop executor; CASIMIR_TEST_FAILPOINT="${1:-}" "${compose[@]}" up -d --force-recreate executor; }
snapshot() {
  local ids
  ids=$(docker ps -aq --filter label=org.casimir.task=execution-poc)
  test -n "$ids"
  # Deliberately omit environment values and database credentials.
  docker inspect $ids --format '{"name":{{json .Name}},"id":{{json .Id}},"role":{{json (index .Config.Labels "org.casimir.role")}},"deploymentId":{{json (index .Config.Labels "org.casimir.deployment")}},"image":{{json .Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"memory":{{json .HostConfig.Memory}},"cpus":{{json .HostConfig.NanoCpus}},"pids":{{json .HostConfig.PidsLimit}},"networks":{{json .NetworkSettings.Networks}}}' > .local/execution/results/execution-resources.ndjson
  checks node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const rows=readFileSync("/results/execution-resources.ndjson","utf8").trim().split("\n").map(JSON.parse);writeFileSync("/results/execution-resources.json",JSON.stringify(rows,null,2));'
}
bootstrap() {
  umask 077
  mkdir -p .local/execution/catalog .local/execution/results
  if ! test -f .local/execution/db.env; then
    local password token
    password=$(openssl rand -hex 24);token=$(openssl rand -hex 32)
    printf 'POSTGRES_USER=casimir_execution\nPOSTGRES_DB=casimir_execution\nPOSTGRES_PASSWORD=%s\n' "$password" > .local/execution/db.env
    printf 'DATABASE_URL=postgresql://casimir_execution:%s@db:5432/casimir_execution\nCASIMIR_TOKEN=%s\nCASIMIR_OPERATOR_ID=casimir_execution_operator\nPORT=4281\n' "$password" "$token" > .local/execution/api.env
  fi
  test -f .local/execution/api.env
  chmod 755 .local/execution/catalog .local/execution/results
  "${compose[@]}" stop executor
  for service in api demo-v1 demo-v2 demo-broken; do
    "${compose[@]}" --profile prepare build "$service"
  done
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile prepare run --rm migrate
  "${compose[@]}" run --rm checks node --input-type=module -e 'import{createRequire}from"node:module";const require=createRequire(new URL("file:///src/platform/packages/api/package.json"));const c=new(require("pg").Client)({connectionString:process.env.DATABASE_URL});try{await c.connect();const r=await c.query("SELECT count(*)::int n FROM casimir.execution_operations WHERE phase NOT IN ($1,$2)",["succeeded","failed"]);if(r.rows[0].n)throw Error("Resolve pending execution before refreshing the catalog");}finally{await c.end();}'
  "${compose[@]}" --profile prepare run --rm routes-init
  "${compose[@]}" --profile prepare run --rm prepare-profile
  if docker volume inspect casimir-execution-poc_appdata >/dev/null 2>&1; then
    test "$(docker volume inspect casimir-execution-poc_appdata --format '{{index .Labels "org.casimir.task"}}')" = execution-poc
  else docker volume create --label org.casimir.task=execution-poc --label org.casimir.scope=casimir-execution-poc casimir-execution-poc_appdata >/dev/null; fi
  "${compose[@]}" up -d api control-ingress app-ingress checks
  checks node platform/packages/api/test/casimir-node/execution-wait.check.mjs
  "${compose[@]}" --profile prepare run --rm operator
}
admission() { checks node --test --test-concurrency=1 platform/packages/api/test/casimir-node/execution-{admission,profile,docker,guard,demo,fixture}.test.mjs; }
jobs_recovery() {
  start_executor after_job_start
  checks env CASIMIR_RECOVERY_JOB_CHECKPOINT=1 node platform/packages/api/test/casimir-node/execution-recovery-admit.mjs
  local jobs
  for attempt in {1..60}; do
    jobs=$(docker ps -aq --filter label=org.casimir.scope=casimir-execution-poc --filter label=org.casimir.role=probe)
    test -n "$jobs" && break
    sleep 1
  done
  test -n "$jobs"
  "${compose[@]}" kill -s SIGKILL executor
  # The abandoned job remains until guarded startup recovery.
  for job in $jobs; do docker inspect "$job" >/dev/null; done
  start_executor
  checks node --test platform/packages/api/test/casimir-node/execution-recovery.test.mjs
  for job in $jobs; do if docker inspect "$job" >/dev/null 2>&1; then return 1; fi; done
  test -z "$(docker ps -aq --filter label=org.casimir.scope=casimir-execution-poc --filter label=org.casimir.role=probe)"
  test -z "$(docker ps -aq --filter label=org.casimir.scope=casimir-execution-poc --filter label=org.casimir.role=data-init)"
  printf 'Interrupted Docker job reconciled before unchanged candidate activation; data preserved; no orphan jobs\n'
}
flow() {
  start_executor
  checks node --test platform/packages/api/test/casimir-node/execution-flow.test.mjs
  snapshot
  checks node --test platform/packages/api/test/casimir-node/execution-boundaries.test.mjs
  "${compose[@]}" --profile prepare run --rm operator node casimir/dist/operator.mjs probe-loopback
}
compensation() {
  for checkpoint in after_old_stop_throw after_route_throw; do
    start_executor "$checkpoint"
    checks node platform/packages/api/test/casimir-node/execution-compensation.check.mjs
  done
  start_executor
}
missing_image() {
  local image result=0
  image=$(docker image inspect casimir-execution-demo:broken --format '{{.Id}}')
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
  test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.casimir.task"}}')" = execution-poc
  test -z "$(docker ps -aq --filter ancestor="$image")"
  docker image save -o .local/execution/missing-image.tar casimir-execution-demo:broken
  trap 'docker image load --input .local/execution/missing-image.tar >/dev/null || true' EXIT
  docker image rm casimir-execution-demo:broken >/dev/null
  checks node platform/packages/api/test/casimir-node/execution-missing-image.check.mjs || result=$?
  if docker image inspect "$image" >/dev/null 2>&1; then result=1; fi
  docker image load --input .local/execution/missing-image.tar >/dev/null
  test "$(docker image inspect casimir-execution-demo:broken --format '{{.Id}}')" = "$image"
  rm .local/execution/missing-image.tar
  trap - EXIT
  return "$result"
}
recovery() {
  start_executor after_route_before_commit
  checks node platform/packages/api/test/casimir-node/execution-recovery-admit.mjs
  "${compose[@]}" kill -s SIGKILL executor
  "${compose[@]}" restart api
  start_executor
  checks node --test platform/packages/api/test/casimir-node/execution-recovery.test.mjs
}
recovery_failure() {
  start_executor after_route_before_commit
  checks node platform/packages/api/test/casimir-node/execution-recovery-admit.mjs
  local candidate
  candidate=$(checks node -e 'console.log(JSON.parse(require("fs").readFileSync("/results/execution-recovery.json","utf8")).candidateId)')
  [[ "$candidate" =~ ^[a-f0-9]{64}$ ]]
  test "$(docker inspect "$candidate" --format '{{index .Config.Labels "org.casimir.scope"}}')" = casimir-execution-poc
  docker stop "$candidate" >/dev/null
  "${compose[@]}" kill -s SIGKILL executor
  start_executor
  checks node --test platform/packages/api/test/casimir-node/execution-recovery-failure.test.mjs
}
legacy() {
  checks node --test --test-concurrency=1 platform/packages/api/test/casimir-node/{config,http,policy,persistence,readiness,retained-state,egress}.test.mjs
}
mismatch() {
  start_executor after_route_before_commit
  checks node platform/packages/api/test/casimir-node/execution-recovery-admit.mjs
  checks node platform/packages/api/test/casimir-node/execution-mismatch.check.mjs inject
  "${compose[@]}" kill -s SIGKILL executor
  start_executor
  checks node platform/packages/api/test/casimir-node/execution-mismatch.check.mjs verify
  "${compose[@]}" stop executor
  checks node platform/packages/api/test/casimir-node/execution-mismatch.check.mjs repair
  start_executor
  checks node --test platform/packages/api/test/casimir-node/execution-recovery.test.mjs
}
egress() {
  "${compose[@]}" exec -T api node --input-type=module < platform/packages/api/test/casimir-node/execution-egress.check.mjs
  local apps
  apps=$(docker ps -q --filter label=org.casimir.scope=casimir-execution-poc --filter label=org.casimir.role=app)
  test "$(printf '%s\n' "$apps" | wc -l)" -eq 1
  docker exec -i "$apps" node --input-type=module < platform/packages/api/test/casimir-node/execution-egress.check.mjs
  docker exec "$apps" node -e 'for(const k of ["DATABASE_URL","CASIMIR_TOKEN"]){if(Object.hasOwn(process.env,k))process.exit(1);}console.log("App has no control credentials")'
}
foreign() {
  "${compose[@]}" stop executor
  local name fixture
  name=$(checks node platform/packages/api/test/casimir-node/execution-foreign.check.mjs admit)
  [[ "$name" =~ ^casimir-execution-poc-app-cex_[a-z0-9]{12}$ ]]
  fixture=$(docker create --name "$name" --label org.casimir.task=execution-poc --label org.casimir.scope=fixture-foreign --label org.casimir.role=fixture-foreign --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --cpus 0.25 --pids-limit 64 casimir-execution-demo:v1 sleep 300)
  start_executor
  checks node platform/packages/api/test/casimir-node/execution-foreign.check.mjs verify
  test "$(docker inspect "$fixture" --format '{{.State.Running}}')" = false
  test "$(docker inspect "$name" --format '{{.Id}}')" = "$fixture"
  "${compose[@]}" stop executor
  docker rm "$fixture" >/dev/null
  checks node platform/packages/api/test/casimir-node/execution-foreign.check.mjs repair
  start_executor
  checks node platform/packages/api/test/casimir-node/execution-foreign.check.mjs recovered
}
guard_live() {
  checks node platform/packages/api/test/casimir-node/execution-live-guard.check.mjs capture
  if "${compose[@]}" exec -T executor node casimir/dist/executor.mjs; then
    printf 'Second executor process unexpectedly acquired ownership\n' >&2; return 1
  fi
  checks node platform/packages/api/test/casimir-node/execution-live-guard.check.mjs unchanged
  "${compose[@]}" stop executor
  local holder=casimir-execution-poc-guard-holder
  "${compose[@]}" run -d --name "$holder" executor sh -c 'node casimir/dist/executor.mjs; sleep 60' >/dev/null
  checks node --input-type=module -e 'import{setTimeout as delay}from"node:timers/promises";await delay(2000);'
  checks node platform/packages/api/test/casimir-node/execution-live-guard.check.mjs terminate
  checks node --input-type=module -e 'import{setTimeout as delay}from"node:timers/promises";await delay(1000);'
  test "$(docker inspect "$holder" --format '{{.State.Running}}')" = true
  "${compose[@]}" start executor
  checks node --input-type=module -e 'import{setTimeout as delay}from"node:timers/promises";await delay(1000);'
  checks node platform/packages/api/test/casimir-node/execution-live-guard.check.mjs unchanged
  test "$(docker inspect casimir-execution-poc-executor-1 --format '{{.State.Running}}')" = false
  docker stop "$holder" >/dev/null
  docker rm "$holder" >/dev/null
  "${compose[@]}" start executor
  checks node --input-type=module -e 'import{setTimeout as delay}from"node:timers/promises";await delay(1000);'
  checks node platform/packages/api/test/casimir-node/execution-live-guard.check.mjs replaced
}
restart_all() {
  checks node platform/packages/api/test/casimir-node/execution-restart.check.mjs capture
  "${compose[@]}" stop executor
  local app
  app=$(docker ps -q --filter label=org.casimir.scope=casimir-execution-poc --filter label=org.casimir.role=app)
  test -n "$app"
  "${compose[@]}" restart db api app-ingress control-ingress
  docker restart "$app" >/dev/null
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile prepare run --rm migrate
  "${compose[@]}" start executor
  checks node platform/packages/api/test/casimir-node/execution-wait.check.mjs app
  checks node platform/packages/api/test/casimir-node/execution-restart.check.mjs verify
}
outage() {
  "${compose[@]}" stop db
  local result=0
  checks node platform/packages/api/test/casimir-node/execution-outage.check.mjs || result=$?
  "${compose[@]}" up -d --wait db
  start_executor
  return "$result"
}
case "${1:-all}" in
  bootstrap) bootstrap;; admission) admission;; flow) flow;; compensation) compensation;; recovery) recovery;; mismatch) mismatch;; egress) egress;; restart) restart_all;; outage) outage;; snapshot) snapshot;;
  foreign) foreign;; guard) guard_live;; legacy) legacy;; recovery-failure) recovery_failure;; missing-image) missing_image;; jobs-recovery) jobs_recovery;;
  all) bootstrap; admission; legacy; flow; missing_image; compensation; recovery; recovery_failure; jobs_recovery; mismatch; foreign; guard_live; restart_all; outage; egress; snapshot;;
  *) printf 'Unknown phase\n' >&2; exit 2;;
esac
