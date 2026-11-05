# Casimir experimental C1 distribution

This profile serves one trusted operator and one project on Linux amd64. Use
synthetic data. It is not a multiuser company platform or a hostile-code sandbox.
Server qualification requires rootful Docker Engine29.9.1, Compose5.6.0, a local
Unix Docker socket, at least2CPUs/8GiB RAM and20GiB free disk (more for large
bundles/backups). Node, builds and developer commands run in Docker.

The self-hosted console adapts Cloudflare's MIT-licensed Void Platform source;
the upstream license is included as `LICENSE`. Its adapted syntax-highlighting
themes have a separate MIT notice in `THIRD_PARTY_NOTICES/remdx-theme-MIT.txt`.
Casimir's mark is original; the upstream license does not imply Cloudflare
endorsement.

C1 bundles require Docker's classic `overlay2` image store. Docker 29's default
containerd image store is unsupported for the bundle's image-ID verification:
`docker load` can expose a manifest/index ID instead of the pinned config ID.
For a fresh daemon, set `/etc/docker/daemon.json` to
`{"features":{"containerd-snapshotter":false},"storage-driver":"overlay2"}`,
restart Docker and confirm `docker info` reports `Storage Driver: overlay2`.
Switching stores can hide images in the previous store; preserve it and plan a
separate migration before changing an existing daemon.

## Transfer and verify

Obtain the whole archive SHA256 through a trusted channel. A checksum proves
integrity, not publisher identity. The separately supplied extraction script uses
a POSIX shell plus GNU coreutils (realpath, sha256sum, mktemp, cp, mv),
GNU tar, awk, grep and sed. Minimal BusyBox-only hosts need those prerequisites
installed before extraction. It refuses links, devices, traversal,
duplicate paths and an existing destination:

```sh
./casimir-c1.0-extract ./casimir-c1.0.tar EXPECTED_SHA256 /opt/casimir/c1.0
cd /opt/casimir/c1.0
./casimir bundle verify
```

The wrapper verifies the lifecycle archive before loading that image, then checks
the entire closed payload catalog offline before loading other roles. Image
archives are individually gzip-compressed. Local Docker image IDs and registry
RepoDigests are recorded separately. Preserve the exact bundle and its hash for
restore; do not edit its files. The JSON schema documents structure; the verifier
also checks bytes, paths, native runtime identity and complete references.

## Installation and TLS

Run the wrapper as the local root Docker operator. Keep the private state directory
outside the bundle. The installation generates a256-bit operator token and a
separate database password, protected by0700 directories/0600 files. Retain the
state path and all named volumes when replacing bundle files.

Create a private operator config JSON with this shape, using certificates issued
by your trusted CA and names resolving to the server:

```json
{"format":1,"mode":"tls","controlOrigin":"https://control.example.test:4485","appOrigin":"https://app.example.test:4486","bindAddress":"127.0.0.1","controlPort":4485,"appPort":4486,"certificatePaths":{"certificate":"/private/config/cert.pem","key":"/private/config/key.pem","ca":"/private/config/ca.pem"}}
```

Use an appropriate server bind address for remote clients; install the CA in each
client/browser trust store. Never bypass certificate validation. Explicit loopback
HTTP mode is only for local clients. External reverse-proxy TLS mode uses `mode: "external-tls"`, loopback-only backend ports and `certificatePaths: {"ca": "/private/config/ca.pem"}`. The external proxy owns its certificate/private key and preserves the original Host header. Public HTTPS origins must resolve and validate from both clients and the operator network; backend ports remain local. Its runtime qualification is separate from bundle-managed TLS. API/apps do not receive the Docker socket or TLS
private key. Trusted ingress has an ordinary front bridge; app/runtime bridges
remain internal and compatibility jobs use network none.

```sh
./casimir install --state /var/lib/casimir/operator --config /private/config/config.json
./casimir auth-setup --state /var/lib/casimir/operator --auth-config /private/config/auth.json --auth-secrets /private/config/auth-secrets.json
./casimir status --state /var/lib/casimir/operator
./casimir stop --state /var/lib/casimir/operator
./casimir start --state /var/lib/casimir/operator
```

`install` keeps management disabled until the root Docker operator runs
`auth-setup`. It enables the original Void administrator setup only when both
the control and app origins use HTTPS and have different hostnames; distinct
ports on one hostname are not enough to isolate the host-only admin cookie.
Existing HTTP and same-host TLS installs remain CLI-only. `auth-setup` refuses
to activate management unless the installation profile already meets those
HTTPS and hostname requirements.

Running `auth-setup` also attaches only the API to the installation-owned
`identity-egress` network for administrator identity requests. It publishes no
new ports and does not attach the database, executor or application containers.
An optional `--identity-policy` file supplies the trusted identity origins,
addresses and CA data for those requests; it does not grant general application
egress. Merely publishing the management configuration files does not create or
activate this network.

For the first setup, pass a Void authentication file and a separate JSON object
whose keys match its `clientSecretEnv` references. Do not put client secrets in
the authentication file. Both files must be canonical absolute paths to regular
0600 files outside the state directory. The authentication file supports the
Void login providers and admission settings; this command does not enact
`cloudflareAccess` or `appAccess`, non-null protection, or the
`cloudflare-access` provider. An optional `--identity-policy` file supplies
trusted IdP network policy and must also be a private 0600 file outside state.

For example, this OIDC authentication-file shape uses Void's existing
`connections[].configuration` and `clientSecretEnv` fields:

```json
{
  "administratorConnectionId": "company",
  "connections": [{
    "clientSecretEnv": "OIDC_CLIENT_SECRET",
    "configuration": {
      "id": "company",
      "kind": "oidc",
      "label": "Company",
      "clientId": "replace-with-client-id",
      "issuer": "https://idp.example.com",
      "allowedDomains": [],
      "requiredGroups": []
    }
  }]
}
```

The corresponding secrets file maps the referenced name to its value:

```json
{"OIDC_CLIENT_SECRET":"replace-with-client-secret"}
```

Void only supports non-empty `allowedDomains` for Google login. Keep this field
as `[]` for OIDC and other providers.

Run the command as the local root Docker operator. Its pending result prints the
setup URL and one-time bootstrap code; treat that code as a credential, enter it
only in the trusted control-origin setup page, and do not save it in logs. If
setup is interrupted or remains pending, rerun `auth-setup` with the same state
path and inputs to resume the saved request. A run that completes omits the
bootstrap code. `auth-setup` is for initial setup and pending retries; after a
complete result, do not rerun it with or without the authentication files. It is
not a status or provider-update command.

The first `install` requires an otherwise-empty state directory. Keep command
transcripts in a separate root-owned private log directory outside `--state`;
redirecting output into a new state directory can make it look like unknown
partial state on the next run. Auth-setup output is sensitive while setup is
pending because it includes the bootstrap code.

Status distinguishes ready-to-deploy, freshly verified serving, stopped,
maintenance and recovery-required. It verifies the actual published TLS listener,
executor ownership, current image and sole writer. Stop gates admission, drains
bounded work, closes ingress and stops the writer before services. Start never
selects a retained older release. A blocked recovery stays blocked; there is no
force-adopt/unblock command. Docker restart policies apply to control services;
apps are reconciled by the guarded executor and have no restart policy.
For installation readiness, inspect `./casimir status --state <state>` and
require `outcome: "ready"`. To verify an app is serving, also require
`code: "serving_verified"` and a fresh `servingObservation`; `code:
"ready_to_deploy"` means no app is currently serving. A zero exit code from
`install`, `start`, or `auth-setup` alone is not a readiness result.

## Backup and isolated restore

Create a separate32-byte random key file owned by root with mode0600 using a trusted operator
key-generation tool. Keep it outside the bundle and protect an independent copy;
losing the key makes the encrypted backup unrecoverable. Never put it in logs.

```sh
./casimir backup --state /var/lib/casimir/operator --output /private/backups/reference.backup --key-file /private/keys/backup.key
```

Backup holds maintenance after verification, with ingress closed and the writer
stopped. This preserves a no-write interval for an upgrade. Explicit `start`
resumes only a verified held backup. A partial or failed operation remains closed
for inspection; never delete volumes to clear it. Backups contain the PostgreSQL
dump, native SQLite snapshot, artifacts, migration/compatibility inventory,
routes, private configuration and logical identities, authenticated with
AES-256-GCM. App code runs only in constrained native jobs, never in the capture
helper. For managed installations, the backup also includes the validated
operator/API configuration pair and any pending auth-setup checkpoint. The
checkpoint remains private to the operator state and is never mounted into the
API or applications. Backup validates the pair and checkpoint before requesting
maintenance; an invalid pending checkpoint leaves the installation untouched.
Legacy CLI-only backups remain valid without management files. The fixed capture
helper has no socket or network, read-only source mounts and only DAC_READ_SEARCH
for the mixed-owner files.

After the API and executor have exited, backup marks unfinished uploads failed
and removes only their exact staging files. Clients must resubmit those uploads;
finalized artifacts and their sealed files remain available. Restore checks free
disk before decrypting or extracting: encrypted backups support up to 16GiB of
payload, and qualification reserves room for plaintext plus extracted files,
image loading, and the 20GiB free-space floor. The checked minimum is
`2 × backup input + 3 × bundle payload + 20 GiB`;
the input and bundle sizes are validated before decrypting or extracting.
Capacity is checked on the state filesystem because plaintext staging is created
inside state; this qualification assumes Docker image storage shares that backing
capacity. A Docker data root on a separate filesystem requires separate capacity
qualification and is not covered by this check.

On a separate clean daemon, stop the source, transfer the exact matching bundle,
backup and separately protected key, then use a new empty private state path:

```sh
./casimir restore --state /var/lib/casimir/restored --input /private/backups/reference.backup --key-file /private/keys/backup.key
./casimir start --state /var/lib/casimir/restored
```

Restore authenticates and checks references before creating installation data
resources. It preserves logical IDs and explicitly records rebuilt image and
container identities. It does not pretend a rebuilt image has the source ID.
For managed state, restore validates the owner/configuration pair and any pending
checkpoint before creating resources. When restoring to a different state path,
it rewrites only the private auth-setup state-path setting; the installation
identity, policy and saved request remain bound to the original checkpoint. If
setup was still pending, resume it with `./casimir auth-setup --state /var/lib/casimir/restored`;
the checkpointed request does not require the original
authentication or secrets files. Post-backup writes are absent by design. A code
downgrade does not undo database migrations, and restoring older data after
exposure is never automatic.

## SDK consumer and source builds

Building from the source tree requires Docker Buildx/BuildKit so the
Dockerfile-specific `.dockerignore` is honored; the C1 runtime bootstrap installs
Docker Engine and Compose but not `docker-buildx-plugin`.

`reference-app/` contains the fixed notes application, packed fork SDK archives
and its exact pnpm lock. The tooling image includes the prepared offline cache
for that graph. Use a writable copy in a Docker developer container; run
`pnpm install --offline --frozen-lockfile --ignore-scripts` and
`pnpm rebuild better-sqlite3`, then the packed Void CLI's Casimir connect/deploy
workflow. Set `CASIMIR_API_URL` to the same HTTPS origin passed to
`void connect`, and put `CASIMIR_TOKEN` in a private client environment file.
Set `NODE_EXTRA_CA_CERTS` to the public CA certificate path inside the Docker
developer container. It never needs the Docker socket or server state. New
dependency graphs require explicit separate cache preparation.
Native `vp preview` is unsupported; the deployed reference app is the native gate.

For the bundled reference app, the tested C1 sample uses the `casimir-reference`
project slug and these SDK commands (replace the fixture control URL with the
URL for your installation):

```sh
pnpm exec void connect --platform casimir https://control.c1.test:4685
pnpm exec void deploy --project casimir-reference
```

Source builds use the steps below from a clean Linux amd64 product checkout.
Dependency and reference-cache preparation need registry/package network access.
The final control build copies the clean checkout over the prepared dependency
image, retains only its installed dependency trees, and rebuilds public packages,
control code, runner runtime, and SDK archives. Record local Docker image IDs
separately from upstream digests in `casimir/images.lock.json`.

### Clean source build, package, and tests

Use Bash, Git, Docker Engine, OpenSSL, and a trusted local Docker operator account.
Run these commands from the product repository root in one Bash session. They
refuse a dirty checkout so the supplied Git revision describes the exact source bytes.
Packaging is a trusted build step: its short-lived helper has the Docker socket
and network disabled so it can inspect and save only the selected local images.
Test containers receive no Docker socket. Never run the packager over unreviewed
code.

```sh
set -eu
test "$(uname -m)" = x86_64
test -z "$(git status --porcelain)"
SOURCE_REVISION="$(git rev-parse HEAD)"
VERSION=c1.0
POSTGRES_IMAGE='postgres:18-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c'
INGRESS_IMAGE='nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'

# Install workspace dependencies from the pinned Node base.
DEPENDENCY_TAG="casimir-c1-dependencies:$SOURCE_REVISION"
docker build --target tooling -f casimir/mvp-a/Dockerfile -t "$DEPENDENCY_TAG" .
DEPENDENCY_ID="$(docker image inspect --format '{{.Id}}' "$DEPENDENCY_TAG")"

# Build the original workspace packages and pack the SDK from this checkout;
# prepare the fixed reference-app dependency graph and its offline cache.
PREPARED_TAG="casimir-c1-prepared:$SOURCE_REVISION"
docker build --build-arg "PREPARATION_BASE=$DEPENDENCY_TAG" \
  -f casimir/install/Tooling.Dockerfile -t "$PREPARED_TAG" .
PREPARED_ID="$(docker image inspect --format '{{.Id}}' "$PREPARED_TAG")"

# Build the selected offline runtime and SDK dependency closure from the same
# prepared source and committed consumer lock.
RUNTIME_TOOLCHAIN_TAG="casimir-c1-node-toolchain:$SOURCE_REVISION"
docker build --build-arg "PREPARATION_BASE=$PREPARED_TAG" \
  -f casimir/install/RuntimeToolchain.Dockerfile -t "$RUNTIME_TOOLCHAIN_TAG" .
RUNTIME_TOOLCHAIN_ID="$(docker image inspect --format '{{.Id}}' "$RUNTIME_TOOLCHAIN_TAG")"

# Build the source-owned control image from this exact checkout.
CONTROL_TAG="casimir-c1-control:$SOURCE_REVISION"
docker build --build-arg "BUILD_BASE=$PREPARED_TAG" \
  --build-arg "RUNTIME_BASE=$RUNTIME_TOOLCHAIN_TAG" \
  -f casimir/install/Dockerfile -t "$CONTROL_TAG" .
CONTROL_ID="$(docker image inspect --format '{{.Id}}' "$CONTROL_TAG")"

# Export the runtime descriptor generated inside the control build for the
# separate runner-image build context. Start with a fresh source checkout.
test ! -e casimir/mvp-a/runner/dist
RUNTIME_CONTAINER="$(docker create "$CONTROL_ID")"
docker cp "$RUNTIME_CONTAINER:/src/casimir/mvp-a/runner/dist" casimir/mvp-a/runner/
docker rm "$RUNTIME_CONTAINER"
RUNTIME_ID="$(docker run --rm --network none --entrypoint node "$CONTROL_ID" \
  -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('/src/casimir/mvp-a/runner/dist/runtime.json','utf8')).runtimeId)")"

RUNNER_BASE_TAG="casimir-c1-runner-base:$SOURCE_REVISION"
docker build -f casimir/mvp-a/runner/Dockerfile -t "$RUNNER_BASE_TAG" casimir/mvp-a/runner
RUNNER_BASE_ID="$(docker image inspect --format '{{.Id}}' "$RUNNER_BASE_TAG")"
RUNNER_TAG="casimir-c1-runner:$SOURCE_REVISION"
docker build --build-arg "RUNNER_BASE=$RUNNER_BASE_TAG" \
  --build-arg "RUNTIME_ID=$RUNTIME_ID" \
  -f casimir/install/Runner.Dockerfile -t "$RUNNER_TAG" .
RUNNER_ID="$(docker image inspect --format '{{.Id}}' "$RUNNER_TAG")"
rm -rf casimir/mvp-a/runner/dist

# Preserve the runner identity labels emitted by Runner.Dockerfile:
# org.casimir.task=mvp-a, org.casimir.distribution=c1, and the generated
# org.casimir.runtime-id. The executor verifies task, runtime-id, and platform;
# distribution is release metadata. Do not override these labels in the recipe.

# Pull the exact data and ingress inputs recorded in images.lock.json.
docker pull "$POSTGRES_IMAGE"
docker pull "$INGRESS_IMAGE"
DATABASE_ID="$(docker image inspect --format '{{.Id}}' "$POSTGRES_IMAGE")"
INGRESS_ID="$(docker image inspect --format '{{.Id}}' "$INGRESS_IMAGE")"

# Package a product bundle. The output stays outside the source checkout.
OUTPUT_DIR="$PWD/.local/c1-output"
mkdir -p "$OUTPUT_DIR"
SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"
docker run --rm --network none \
  --user "$(id -u):$(id -g)" --group-add "$SOCKET_GID" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$PWD,target=/src,readonly" \
  --mount "type=bind,source=$OUTPUT_DIR,target=/output" \
  --workdir /src --entrypoint node "$CONTROL_ID" \
  casimir/install/package.mjs "/output/$VERSION" "$VERSION" \
  "$SOURCE_REVISION" "$CONTROL_ID" "$RUNNER_ID" "$DATABASE_ID" "$INGRESS_ID"

# Keep exact local build inputs beside the archive; Docker image IDs are local
# to this daemon and are not registry digests.
printf 'source_revision=%s\nversion=%s\ndependency_image_id=%s\nprepared_image_id=%s\nruntime_toolchain_image_id=%s\ncontrol_image_id=%s\nrunner_base_image_id=%s\nrunner_image_id=%s\ndatabase_image=%s\ndatabase_image_id=%s\ningress_image=%s\ningress_image_id=%s\nruntime_id=%s\n' \
  "$SOURCE_REVISION" "$VERSION" "$DEPENDENCY_ID" "$PREPARED_ID" \
  "$RUNTIME_TOOLCHAIN_ID" \
  "$CONTROL_ID" "$RUNNER_BASE_ID" "$RUNNER_ID" "$POSTGRES_IMAGE" \
  "$DATABASE_ID" "$INGRESS_IMAGE" "$INGRESS_ID" "$RUNTIME_ID" \
  > "$OUTPUT_DIR/$VERSION-build-inputs.txt"
```

The packager writes `/output/<version>.tar`, its SHA-256 file, and an extraction
helper. For a `c1.1` target, repeat from its own clean reviewed revision and set
`VERSION=c1.1`; do not change a manifest version after packaging. Keep the source
revision and control, runner, database, and ingress image IDs with the output as
build evidence. The runtime bundle excludes browser QA tools and anything under `.local/`. No parent
workspace, registry publication, GitHub account, or original checkout is needed
to operate a transferred bundle.

The focused source tests need an isolated PostgreSQL daemon and synthetic data.
The example uses a private Docker network, the pinned PostgreSQL image, tmpfs
storage over its declared `/var/lib/postgresql` volume and `PGDATA` path, a
newly created upgrade-replay database, and a separate absent-before bootstrap
database created and dropped by its test. Bootstrap tests require the explicit
generated environment path, a date/random database selector and the dedicated
network alias; they refuse the old default environment before connecting or
running migrations. Do not point these tests at an existing development or
production database. Run the test database setup and test commands in the same
Bash session after building `CONTROL_ID` above. That source-owned image contains
generated control code and workspace dependencies. This also requires OpenSSL
for a generated local-only password.

```sh
set -eu
TEST_DATE="$(date -u +%Y%m%d)"
TEST_RANDOM="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
TEST_NETWORK="casimir-c1-source-test-$TEST_DATE-$TEST_RANDOM"
TEST_DB_CONTAINER="casimir-c1-source-test-db-$TEST_DATE-$TEST_RANDOM"
TEST_REPLAY_DB="casimir_c1_upgrade_replay_${TEST_DATE}_${TEST_RANDOM}"
TEST_BOOTSTRAP_DB="casimir_c1_bootstrap_${TEST_DATE}_${TEST_RANDOM}"
TEST_WORKDIR="$PWD/.local/c1-source-test-$TEST_DATE-$TEST_RANDOM"
TEST_DB_PASSWORD="$(openssl rand -hex 24)"
docker network create --internal --label org.casimir.task=c1 \
  --label org.casimir.role=source-test "$TEST_NETWORK" >/dev/null
docker run --detach --name "$TEST_DB_CONTAINER" --network "$TEST_NETWORK" \
  --network-alias casimir-c1-source-test-db \
  --label org.casimir.task=c1 --label org.casimir.role=source-test-db \
  --tmpfs /var/lib/postgresql:rw,size=512m \
  --env POSTGRES_USER=casimir_c1 --env "POSTGRES_PASSWORD=$TEST_DB_PASSWORD" \
  --env POSTGRES_DB=casimir_c1 "$POSTGRES_IMAGE" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d casimir_c1 -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d casimir_c1 -Atc 'SELECT 1')" = 1
PGDATA="$(docker exec "$TEST_DB_CONTAINER" printenv PGDATA)"
test "$PGDATA" = /var/lib/postgresql/18/docker
test "$(docker inspect --format '{{index .HostConfig.Tmpfs "/var/lib/postgresql"}}' "$TEST_DB_CONTAINER")" = 'rw,size=512m'
test "$(docker inspect --format '{{len .Mounts}}' "$TEST_DB_CONTAINER")" = 0
test "$(docker exec "$TEST_DB_CONTAINER" df -T "$PGDATA" | awk 'NR==2 {print $2 ":" $7}')" = 'tmpfs:/var/lib/postgresql'
test -z "$(docker port "$TEST_DB_CONTAINER")"
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_REPLAY_DB'")" = 0
docker exec "$TEST_DB_CONTAINER" createdb -U casimir_c1 -O casimir_c1 "$TEST_REPLAY_DB"
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='$TEST_REPLAY_DB'")" = casimir_c1
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_BOOTSTRAP_DB'")" = 0
test ! -e "$TEST_WORKDIR"
mkdir -m 700 -p "$TEST_WORKDIR"
chmod 700 "$TEST_WORKDIR"
(umask 077; printf 'DATABASE_URL=postgres://casimir_c1:%s@casimir-c1-source-test-db:5432/casimir_c1\n' \
  "$TEST_DB_PASSWORD" > "$TEST_WORKDIR/test.env")
chmod 600 "$TEST_WORKDIR/test.env"

# Typecheck and run the focused lifecycle suite in the source-built control image.
docker run --rm --network none --entrypoint sh "$CONTROL_ID" -c \
  'pnpm exec vp run --filter ./platform/packages/api typecheck'
docker run --rm --network "$TEST_NETWORK" \
  --mount "type=bind,source=$TEST_WORKDIR/test.env,target=/tmp/c1-test.env,readonly" \
  --env CASIMIR_C1_TEST_ENV_FILE=/tmp/c1-test.env \
  --env "CASIMIR_C1_UPGRADE_TEST_DATABASE=$TEST_REPLAY_DB" \
  --env "CASIMIR_C1_BOOTSTRAP_TEST_DATABASE=$TEST_BOOTSTRAP_DB" \
  --entrypoint node "$CONTROL_ID" --test --test-concurrency=1 \
  casimir/install/test/operate.test.mjs \
  casimir/install/test/upgrade-db.test.mjs \
  casimir/install/test/upgrade-pair.test.mjs \
  casimir/install/test/bootstrap-db.test.mjs \
  casimir/install/test/bootstrap-db-preflight.test.mjs \
  casimir/install/test/bootstrap-wrapper.test.mjs

test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_REPLAY_DB'")" = 1
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_BOOTSTRAP_DB'")" = 0
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='$TEST_REPLAY_DB'")" = 0
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d "$TEST_REPLAY_DB" -Atc \
  "SELECT count(*) FROM pg_namespace WHERE nspname = ANY(ARRAY['casimir_install','casimir_mvp_a'])")" = 0
docker exec "$TEST_DB_CONTAINER" dropdb -U casimir_c1 "$TEST_REPLAY_DB"
test "$(docker exec "$TEST_DB_CONTAINER" psql -U casimir_c1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='$TEST_REPLAY_DB'")" = 0
rm -f "$TEST_WORKDIR/test.env"
docker stop "$TEST_DB_CONTAINER" >/dev/null
docker rm "$TEST_DB_CONTAINER" >/dev/null
docker network rm "$TEST_NETWORK" >/dev/null
rmdir "$TEST_WORKDIR"
```

The pinned PostgreSQL image declares `VOLUME /var/lib/postgresql` and sets
`PGDATA=/var/lib/postgresql/18/docker`; the tmpfs covers both. The checks verify
the configured tmpfs, its live filesystem type at `PGDATA`, zero Docker-managed
mounts/anonymous volumes, and no published port. Synthetic databases disappear
with that tmpfs.
On a failed test, keep only these exact named resources while investigating,
then clean them after recording the outcome. Never use a global prune or remove a
volume to clear test state. Browser and clean-daemon install/upgrade/recovery gates
are separate from these source checks and are not implied by a passing test run.

## Retention and uninstall

```sh
./casimir retention --state /var/lib/casimir/operator
./casimir uninstall --state /var/lib/casimir/operator
```

Retention is a conservative preview. It reports owned stopped platform containers,
empty owned networks, retained data and image references. Image sizes are Docker's
reported logical sizes, not reclaimable unique bytes; unavailable volume sizes
are reported as `null`. Current, previous, pending, blocked and verified-backup
references pin releases. All remaining images are retained as well; automatic
image/artifact garbage collection is deferred. The last successful stop records
the database reference inventory before taking the database offline.
The private retention inventory and restored operation mapping are each limited
to 768KiB. New deployment and backup admission reserve space for the next history
entry and refuse before crossing the supported limit (2048 operations, 256
verified backups, or the byte cap). Stop remains available for older oversized
history and writes a `preserve_all` inventory marker; retention reports uncertain
owned app/job, platform container, network and image references as retained, and
uninstall refuses destructive cleanup while that marker is present. Identity
and receipt files keep their separate 64KiB limit.

Uninstall first performs the normal guarded stop. It removes only exact owned
platform containers and empty owned networks. It preserves application containers,
every persistent volume, private state/configuration, images and backup files.
An interrupted removal stays closed: rerun `uninstall` with the same state path.
A completed uninstall can be restarted with `start` and its retained bundle/state.
Never remove volumes to resolve a failed lifecycle operation. C1 rejects new
upload/deployment admission below its measured20GiB disk reserve; it does not
reclaim recovery data automatically.

### Declared control upgrade

The only declared forward pair is `c1.0` to `c1.1`. Run the **target c1.1
bundle's** wrapper after verifying/extracting that bundle. The c1.0 source
wrapper does not provide an upgrade command. First create a verified source
backup and leave its maintenance gate held:

```sh
/source-bundle/casimir backup --state /srv/casimir/state --output /srv/casimir/backups/pre-upgrade.backup --key-file /srv/casimir/keys/backup.key
/target-bundle/casimir upgrade --state /srv/casimir/state --backup /srv/casimir/backups/pre-upgrade.backup
```

The target checks the exact source manifest, encrypted backup hash, unchanged
application runtime/SDK/dependency image identities and declared schema pair.
It applies the forward control migration in a transaction, checks current and
retained prior images against cloned backup snapshots, then resumes the existing
application. Application data is not rolled back. Interrupted upgrades must be
retried using the same target bundle, backup and state path; ordinary start/stop
commands refuse an incomplete upgrade. A failure retains maintenance or recovery
state. Keep the source bundle and separate backup key for explicit restoration
on an empty destination. Downgrade and arbitrary version pairs are refused.

These commands remain experimental; consult `SUPPORT.md` for qualification
limits. A supported pair declaration alone is not evidence of a completed
installation-specific upgrade or a successful recovery test.
