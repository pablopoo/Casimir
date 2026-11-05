# Native SDK compatibility experiment

This experimental profile adds native SQLite to the Node target. It is not the
self-hosted MVP distribution. Development and verification run in Docker.

```ts
import { defineConfig } from 'void/config';
export default defineConfig({ target: 'node', casimir: { profile: 'node-sqlite-v1' } });
```

The profile keeps file-based routes, React Pages and schema-aware `void/db`.
Its native database uses the supported Drizzle CRUD API, not D1 sessions or D1
result metadata. KV, storage, managed authentication and other Cloudflare
services remain unavailable. The experimental Casimir destination accepts a
bundled artifact and deploys it through a guarded executor. This increment is
limited to one trusted operator/project on a Linux amd64 Docker host.

Build and start a disposable verification container from the product root:

```sh
docker build --target validation -f casimir/mvp-a/Dockerfile -t casimir-mvp-a-validation:local .
docker run -d --init --name casimir-mvp-a-tooling --label org.casimir.task=mvp-a \
  --memory 6g --cpus 2 --pids-limit 512 --user node --workdir /src \
  casimir-mvp-a-validation:local sleep infinity
bash casimir/mvp-a/verify.sh sdk
```

An existing container with that name must be inspected before replacement.
The verification phase uses its image's source, so rebuild it after code changes.
Installed-package tests prepare dependencies, install locally packed SDK
archives into a separate consumer, and run actual browser/API checks. They may
download dependency metadata during preparation; prepared offline validation uses
`CASIMIR_TEST_OFFLINE=1` inside the test container.
For a fully offline rerun, first complete the SDK gate with setup network access
and retain its complete pnpm store/cache. A frozen workspace installation alone
does not seed every fresh consumer's registry metadata and package snapshots.
Transfer that cache only while the package manager is idle; validation then runs
with networking disabled and the same source/tests.

The reference app is under `casimir/examples/notes`. `SERVER_ONLY` is a required
server-only runtime value; provide your own local synthetic value for testing.
Application data lives in the profile's local `.void` directory. Do not point
this experiment at data from an existing platform installation.

The artifact format is gzip-framed `CASIMIR1`, a canonical closed JSON manifest,
then regular file contents in sorted manifest order. It accepts at most64MiB
compressed,256MiB expanded including framing,4096 files and1MiB of manifest.
It rejects links, private dotfiles, node_modules, native addons, unprovided SSR
imports and mismatched SDK/runtime/ABI. Vite's generated `.vite/manifest.json`
and `.vite/ssr-manifest.json` are allowed explicitly. Application JS is bundled;
only the pinned native driver/HTTP server and Node builtins remain external.
Each JavaScript module is capped at4MiB and400,000 conservative raw lexemes
before parser allocation in the512MiB API. The lexeme count includes punctuation
in strings/comments, so a legitimate dense module may need smaller chunks.
Larger binaries still use the aggregate wire limits. Finalizations serialize.

Run the real HTTP/PostgreSQL admission checks from the product root:

```sh
bash casimir/mvp-a/verify.sh admission
```

Preparation creates new private credentials in `.local/mvp-a`, preserves them on
rerun, and starts only the task-labelled database in `casimir/mvp-a/compose.yaml`.
It uses the previously built tooling image/container. Admission checks create and
drop only randomly named `casimir_mvp_a_test_*` databases on that dedicated service.
Those fixture databases and fake artifact files are disposable. Persistent Docker
volumes and other projects are preserved. The API test process has no Docker mount.
Admission records a deployment intent; serving/execution remains a separate gate.

Run the installed CLI and real Docker serving checks:

```sh
bash casimir/mvp-a/verify.sh cli
```

This prepares the pinned native runner and control images, starts the dedicated
control stack, installs locally packed SDK archives into a disposable consumer,
and runs `void connect --platform casimir`, `void deploy` and `void project status`.
The first deployment checks SSR/assets/API SQLite writes. A same-schema update
drops an accepted admission response and retries with the original artifact/key.
Chromium submits the deployed form; a forged-origin replay must still receive403.
Control/app ingress bind to127.0.0.1 ports4285/4286. An in-container loopback
forwarder carries the CLI's real HTTP traffic to that control ingress.

The API and application containers have no Docker socket. Only the trusted
executor has it; application build contexts contain a fixed base/COPY recipe.
Runtime values come from an operator-owned private file outside the artifact;
the mounted copy contains only declared keys. CLI credentials use a separate
origin-scoped0600 Casimir store. Build-child env removes the control token.
Trusted application code shares the build user's filesystem; this profile does
not isolate adversarial code. Docker containers share the host kernel.

Validation retains the dedicated database, application data and release records
on rerun. It does not run production seed code. Its own consumer source is under
ignored `.local/mvp-a/consumer`; do not use that path for real application work.
Run the remaining gates in order, from the same product root and tooling source:

```sh
bash casimir/mvp-a/verify.sh flow
bash casimir/mvp-a/verify.sh recovery
bash casimir/mvp-a/verify.sh legacy
bash casimir/mvp-a/verify.sh capacity
```

`flow` adds a table/index, proves the retained release's CRUD hook against a
migrated snapshot, rejects unsafe SQL/edited history and compensates an unhealthy
candidate. `recovery` kills/recreates the executor at four cutover boundaries,
tests real guard-session loss, kills an isolated compatibility job, restarts the
services and checks external DNS/HTTPS/direct-IP denial. `legacy` uses fresh
disposable databases for existing API/execution behavior. `capacity` accepts the
maximum wire/module boundary and rejects excessive syntax density without taking
down the API. `all` runs sdk/admission/cli/flow/recovery/legacy/capacity in order.
Use `CASIMIR_TOOL_CONTAINER=name` consistently for another task-labelled tooling
container. These gates are validation tooling, not a company-server installer.

Migration files are immutable once applied. This profile accepts narrowly parsed
new ordinary tables and nonunique indexes; destructive/constraint-changing DDL
is rejected. Each batch and its hash history commit in one native SQLite
transaction. Production seed files are never executed. The author-owned
`compatibility/check.js` exports `verifyCompatibility({db,schema,recordId})`;
its old-schema CRUD cases run only on a disposable migrated snapshot, with no
live-data mount or external network. It is bounded evidence for the declared
cases, not general application compatibility.

Ingress closes and the old writer stops before the live batch. An interrupted
operation resumes its durable receipt; `void deploy` reuses an unfinished local
retry record. Image rollback cannot undo exposed data: after any possible public
write, recovery uses current data with proven-compatible retained code or blocks.
The separate last gate below deliberately injects a foreign writer, verifies its
data is preserved, and leaves ingress closed with `recovery_required`:

```sh
bash casimir/mvp-a/verify.sh foreign
```

Run it only on this dedicated experiment after the other gates. It removes only
its injected container; there is no automatic unblock or volume deletion. Keep
the receipt, journals and volumes for operator investigation. This is a gate for
the trusted single-project profile, not a recovery administration interface.

For contributions, use synthetic data and Docker for builds/tests, retain MIT
licensing/attribution, and keep local credentials under ignored `.local`. Source
builds need only this repository; generated SDK archives are local test inputs.
No package registry account or parent workspace files are required. The installer,
corporate identity, broader services and publication remain later work.
