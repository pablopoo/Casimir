# Casimir local control experiment

This profile runs a small Node/PostgreSQL control adapter using Void Platform's
project ownership, access checks, and deployment-record persistence. It creates
pending records only: it does not build, execute, or publish applications.

Based on Void 1.1.11, revision `a38b1f874e16e52a9b32539163f80f2ba6c6b966`.
The upstream MIT license and copyright notices apply to reused source.

## Prepare

Run from this repository's root. Requirements: Docker Engine and Docker Compose,
Internet for initial image/dependency preparation, and free loopback port 4281.
All application tooling runs inside Docker. The pinned images are recorded in
`casimir/images.lock.json` and the Dockerfile/Compose configuration.

Create local credentials (do not commit them or copy credentials from another
project):

```sh
mkdir -p .local/results
umask 077
task_db_password=$(openssl rand -hex 24)
task_api_token=$(openssl rand -hex 32)
printf 'POSTGRES_USER=casimir\nPOSTGRES_DB=casimir\nPOSTGRES_PASSWORD=%s\n' "$task_db_password" > .local/db.env
printf 'DATABASE_URL=postgresql://casimir:%s@db:5432/casimir\nCASIMIR_TOKEN=%s\nCASIMIR_OPERATOR_ID=casimir_operator\nPORT=4281\n' "$task_db_password" "$task_api_token" > .local/api.env
unset task_db_password task_api_token
```

Keep these files and existing volumes for subsequent runs. Regenerating the
password does not change an already initialized PostgreSQL volume's password.

```sh
docker compose -p casimir-control-m1 -f casimir/compose.yaml build api checks
docker compose -p casimir-control-m1 -f casimir/compose.yaml up -d --wait db
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm migrate
docker compose -p casimir-control-m1 -f casimir/compose.yaml up -d ingress
```

The API is exposed through a fixed local ingress at `http://127.0.0.1:4281`;
PostgreSQL has no published port. The ingress joins a separate front network;
the API itself stays on the internal network and has no host port or socket mount.
Ingress forwards only to the fixed API backend and is not an outbound proxy.
The API and PostgreSQL use an internal runtime network without Internet egress.
The API runs as a non-root user with no Docker socket, a read-only root filesystem,
and CPU/memory limits. This is not isolation against hostile application code or
a production security assessment. Readiness requires migration history matching
the pinned source and a successful database query.

## HTTP contract

Except for `GET /health`, send `Authorization: Bearer <CASIMIR_TOKEN>` using the
token in your local configuration. The fixed token identifies the seeded local
operator; it does not demonstrate a complete identity or multiuser system.
Database configuration supports explicit PostgreSQL network URLs with a hostname
and database path; opaque/hostless URLs and implicit database selection are rejected
before the server listens. Invalid startup configuration does not print the token.

| Request                                         | Behavior                                                     |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `POST /projects` with `{"slug":"casimir-demo"}` | Create a project and ownership history.                      |
| `GET /projects/:id`                             | Read an authorized project.                                  |
| `POST /projects/:id/deployments` with `{}`      | Record a pending deployment with actor/owner attribution.    |
| `GET /projects/:id/deployments`                 | List recent records and the separate active pointer.         |
| `POST /projects/:id/deploy`                     | Explicitly unsupported (501).                                |
| `GET /health`                                   | Readiness (200) or unavailable/uninitialized database (503). |

Project slugs retain Void's reserved-name, format, 56-character limit, uniqueness,
and short-name plan policy. The initial free plan rejects names of five or fewer
characters. Missing/invalid credentials return 401; suspended or unauthorized
actors return 403. Bodies are limited to 16 KiB. This is a Casimir-specific
record API, not the official Void CLI/Worker manifest-deploy protocol.

## Verify

These commands exercise synthetic data in the Casimir database and retain it.
Tests create additional fictional users/projects and an empty database named
`casimir_unmigrated_test` for negative readiness verification.

```sh
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm checks
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm checks node casimir/verify-restart.mjs before
docker compose -p casimir-control-m1 -f casimir/compose.yaml restart api db
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm migrate
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm checks node casimir/verify-restart.mjs after
```

`before` saves a synthetic HTTP/SQL snapshot to `.local/results/restart.json`;
`after` requires the same snapshot and volume. Restart verification does not
delete/reseed projects or substitute new IDs. Initialization preserves later
operator values. Deployment records remain pending and the active pointer stays
null. Multiple records can exist; no job admission/recovery guarantee is implied.

To verify loss of the database, stop only this profile's database, run the outage
check, and restore it even if the test fails:

```sh
docker compose -p casimir-control-m1 -f casimir/compose.yaml stop db
docker compose -p casimir-control-m1 -f casimir/compose.yaml run --rm checks node --test platform/packages/api/test/casimir-node/outage.check.mjs
docker compose -p casimir-control-m1 -f casimir/compose.yaml up -d --wait db
```

The normal check set verifies external DNS, Cloudflare HTTPS, and direct-IP TCP
are blocked. Its Node build records the actual source modules in
`casimir/dist/provenance.json`; no Worker mocks are used for portability checks.
Existing upstream tests are additional regression evidence, not portability proof.

Verify the host loopback binding with a Dockerized client as well:

```sh
docker run --rm --network host node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 node --input-type=module -e 'const r=await fetch("http://127.0.0.1:4281/health"); if(r.status!==200)process.exit(1); console.log("Loopback ready");'
```

## Stop and retain data

```sh
docker compose -p casimir-control-m1 -f casimir/compose.yaml down
```

This removes the profile's containers/network and preserves its named PostgreSQL
volume. Do not add `--volumes` unless you explicitly intend to destroy its data.
Discard only task-owned unused images/cache after use, without force or global
prune; preserve shared base images and anything still in use.

## Local execution experiment

This optional profile adds a trusted Docker executor to the record-only control.
It operates one project/app on one Linux Docker host, with brief downtime and an
unchanged SQLite schema. It is an experiment, with no production/HA, tenant
sandbox, Cloudflare API compatibility or data rollback claim. The executor's
Docker socket is host privilege; the API, apps, ingress and ordinary checks do
not receive it. Only a trusted operator should run this profile.

From the product repository root, with Docker Compose, Bash, OpenSSL and free
loopback ports4283(control) and4284(app):

```sh
bash casimir/verify-execution.sh bootstrap
bash casimir/verify-execution.sh admission
bash casimir/verify-execution.sh flow
bash casimir/verify-execution.sh compensation
bash casimir/verify-execution.sh recovery
bash casimir/verify-execution.sh mismatch
bash casimir/verify-execution.sh foreign
bash casimir/verify-execution.sh guard
bash casimir/verify-execution.sh restart
bash casimir/verify-execution.sh outage
bash casimir/verify-execution.sh egress
```

`bash casimir/verify-execution.sh all` runs the ordered acceptance experiment.
The mismatch/foreign/guard phases deliberately inject faults into this profile's
synthetic test state and repair only the exact changes they created. Do not run
these fault tests against real application data. Each execution request creates
a retained deployment/operation; reruns preserve previous history and records.
A pre-existing unexplained route/data binding or blocked operation fails closed
and requires operator investigation; bootstrap never resets it.

Bootstrap generates fresh credentials once under ignored `.local/execution`.
It builds only the three fixed `demo-v1`, `demo-v2`, `demo-broken` aliases,
resolves their immutable **local image IDs** (not registry digests) into
`.local/execution/catalog/profile.json`, applies both migration runners and
initializes a503 route only if absent. Catalog preparation receives only its
output directory and the socket. Never overwrite initialized database passwords,
delete volumes or copy another project's credentials. Task resources use the
`casimir-execution-poc` names and `org.casimir.task=execution-poc` label.

The wrapper exports the socket's existing group ID as `CASIMIR_DOCKER_GID`;
it never changes socket permissions. Equivalent operator commands include:

```sh
export CASIMIR_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose -f casimir/execution.compose.yaml --profile prepare build api demo-v1 demo-v2 demo-broken
docker compose -f casimir/execution.compose.yaml up -d --wait db
docker compose -f casimir/execution.compose.yaml --profile prepare run --rm migrate
docker compose -f casimir/execution.compose.yaml --profile prepare run --rm routes-init
docker compose -f casimir/execution.compose.yaml --profile prepare run --rm prepare-profile
```

Use the bootstrap wrapper for the complete ordered setup, including labeled
storage verification and network creation. Control runs at
`http://127.0.0.1:4283`, app ingress at `http://127.0.0.1:4284`; PostgreSQL and app
containers have no published ports. API/app networks are internal. Each ingress
has its own front network so loopback publication actually works.

Authenticated `POST /projects/:id/deployments/:deploymentId/execute` takes exactly
`{"imageAlias":"demo-v1"}` and a printable ASCII `Idempotency-Key` of1–128
characters. It returns202 after durable intent, **not publication**. Same key/input
returns the same receipt after a live permission check; changed input conflicts.
Read `GET /projects/:id/operations/:operationId` for requested image, phase,
authoritative SQL pointer, timestamped last observation, outcome and safe error.
Only verified loopback/Docker observations plus conditional SQL finalization yield
`succeeded/activated`. `recovery_required` blocks further execution; a historical
observation does not assert current availability. Without an execution catalog,
existing record-only mode remains available and execution returns authenticated501.

The executor preflights with read-only SQLite, stops/verifies the old writer,
then recreates the candidate writable. A fixed proxy config is fingerprinted and
atomically replaced. Updates retain data and old deployment records. Compensation
restores and probes the old target before reporting `failed/restored`; an
unprovable result stays blocked. SQLite has immutable scope/project metadata,
so a fresh control database cannot adopt another project's old app volume.

The dedicated PostgreSQL advisory lock is held by a separate session. Session
loss stops effects and exits; takeover also requires the old container incarnation
to be stopped/absent. A second process in the same running container is refused.
This is conservative single-host ownership, not distributed fencing or live
failover under partition. Operator-only `CASIMIR_TEST_FAILPOINT` values are
`after_old_stop_throw`, `after_route_throw`, `after_route_before_commit`,
`after_job_start`. The last pauses after a trusted job starts, for interruption
testing with `bash casimir/verify-execution.sh jobs-recovery` (also part of `all`).
Probe and data-initialization containers record operation, executor instance and
profile ownership in Docker metadata. Guarded startup validates every leftover
job's recorded ownership and fixed recipe before stopping/removing it, before
operation recovery or another candidate starts. Conflicts block startup. This
does not fence an unbounded Docker request completing after the startup scan;
the profile assumes one trusted host mutator.

The additive `casimir` SQL schema has its own SHA256-verified migration journal.
It does not alter the upstream54-entry journal (last numeric index60). Migration
errors and applied-hash drift fail readiness rather than being ignored.

Bounded upstream validation runs separately, with no database credential/socket:

```sh
docker compose -f casimir/execution.compose.yaml --profile validation build validation
docker compose -f casimir/execution.compose.yaml --profile validation up -d validation
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run build
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run --filter './platform/packages/**' build
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run check
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run test --list --base 8f74afa
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run test --base 8f74afa
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp test run --maxWorkers=1 --no-file-parallelism
```

Validation has6GiB RAM/8GiB RAM+swap,2CPUs,512PIDs, an init reaper, synthetic
kitchen-sink settings and an offline network. Build prerequisites before checking.
Keep isolation enabled and account for failures/skips. Do not run another broad
suite merely to repeat successful evidence. No validation command publishes.

Named volumes `casimir-execution-poc_{database,appdata,routes}` contain persistent
state and must be preserved. `docker compose -f casimir/execution.compose.yaml stop`
stops Compose services but does not stop dynamically created apps; identify those
by their task/scope/role labels and exact recorded IDs. Never use global prune,
forced image removal, `down -v` or remove other projects' resources. Retain images
and stopped app containers needed to recover recorded targets; remove discarded
probe/init/validation resources and task-specific cache only after use.

Catalog changes require stopped inflight work and recreated API/executor containers;
bootstrap refuses a catalog refresh while a nonterminal operation remains.
`bash casimir/verify-execution.sh recovery-failure` also tests a candidate that
fails during crash recovery and requires verified restoration.

The root check also needs playground-generated configuration. After the two
prerequisite builds above, run this before `vp run check`:

```sh
docker compose -f casimir/execution.compose.yaml exec -T validation pnpm exec vp run --filter './playground/**' --parallel --concurrency-limit=2 build
docker compose -f casimir/execution.compose.yaml exec -T validation node test/check-playground-build-artifacts.mjs
```

The affected runner accepts no worker flags. For bounded affected execution,
use its `--list --base 8f74afa` output and run the selected paths directly with
`vp test run --maxWorkers=1 --no-file-parallelism`, preserving project selection.
