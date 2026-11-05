# Experimental C1 support boundary

Supported architecture: one trusted operator, one project, Linux amd64, rootful
Docker Engine29.9.1 and Compose5.6.0, fixed Node24/native SQLite runtime. Runtime,
SDK, PostgreSQL-major and arbitrary application driver upgrades are outside this
profile. Docker containers share the host kernel and are not a hostile-code
security boundary.

C1 bundles require Docker's classic `overlay2` image store. Docker 29's default
containerd image store is unsupported for the bundle's image-ID verification:
`docker load` can expose a manifest/index ID instead of the pinned config ID.
For a fresh daemon, set `/etc/docker/daemon.json` to
`{"features":{"containerd-snapshotter":false},"storage-driver":"overlay2"}`,
restart Docker and confirm `docker info` reports `Storage Driver: overlay2`.
Switching stores can hide images in the previous store; preserve it and plan a
separate migration before changing an existing daemon.

Keep the immutable bundle, trusted archive hash, private installation state and
all named volumes. Backup encryption keys are separate operator-managed inputs;
use root-owned mode0600 files and root-owned mode0700 parent directories. Copying
files between systems may change ownership: check it before running a lifecycle
command. Never place keys, tokens or private dumps in an issue or shared log.
Keep command transcripts in a separate private directory outside a new `--state`
path. Pending `auth-setup` output contains the one-time bootstrap code and must
be handled as a credential.

For a failure, retain the exact bundle version/source revision, installation ID,
command, outcome code and timestamp. Inspect bounded Docker logs locally. A command
exit0 alone does not establish readiness: inspect the structured outcome/code.
For an installed system, `outcome: "ready"` means its control plane is ready.
For an app to count as serving, require `./casimir status --state <state>` to
report `outcome: "ready"`, `code: "serving_verified"`, and a fresh
`servingObservation`. `code: "ready_to_deploy"` means no app is serving yet.
Successful command completion or `auth-setup` status alone is not a readiness
check.
`blocked` or `recovery_required` means admission must stay closed. There is no
force-adopt, automatic downgrade, volume-reset or data-repair command.

Void permits non-empty `allowedDomains` only for Google login. Use `[]` for OIDC
and other providers. Preserve the runner image's `org.casimir.task=mvp-a`,
`org.casimir.distribution=c1` and `org.casimir.runtime-id` labels. The executor
verifies task, runtime-id and platform; the distribution label is release
metadata.

If backup or restore rejects a managed auth setup checkpoint, preserve the state
directory, encrypted backup and separate backup key. Do not edit or remove the
checkpoint to bypass validation. A failed backup preflight rejects the operation
before maintenance is requested. After restoring pending setup to a new state
path, resume with `auth-setup` against that restored path; the saved request and
installation authority remain unchanged.

The reproducible developer workflow uses the shipped reference app, exact lock
and packed fork SDK inside Docker. Its offline dependency cache supports that
prepared graph only. Standard native `vp preview`, multiuser administration,
per-project egress enablement, automatic full garbage collection, scheduled/offsite
backups and general-purpose upgrades are deferred.

Qualification must distinguish a real host reboot from a Docker daemon restart.
Two independent Docker-in-Docker stores exercise transfer and restore isolation;
they do not prove physical/VM reboot behavior or every Linux host configuration.
Publication, production certification and general company rollout require their
own acceptance decisions.
