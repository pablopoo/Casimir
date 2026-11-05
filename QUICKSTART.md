# Casimir quickstart

Casimir is an experimental, single-operator/single-project preview. This source
checkout does not include a public prebuilt bundle. Build the bundle from source
before installing it; the build fetches dependencies and needs registry access.

## Prerequisites

- Linux amd64 with rootful Docker Engine, the Docker Compose plugin, and the
  classic `overlay2` image store.
- At least 8 GiB RAM and 20 GiB free disk for the current server profile.
  Source builds and large bundles need additional resources.
- CPU capacity affects build/deployment time and throughput; no measured CPU
  minimum has been established. Size it for your workload.
- Two DNS names resolving to the server: one for the control plane and one for
  published apps. Prepare HTTPS certificates trusted by operators and browsers.
  The control and app names must differ; separate ports on one hostname do not
  isolate the administrator cookie.
- An operator-managed OIDC provider. Register the exact redirect URI
  `<control-origin>/auth/callback`; have its issuer, client ID and client secret
  ready. Its hostname must resolve from the API containers as well as browsers;
  configure Docker to use your company DNS if needed. The identity-policy address
  list is an allowlist, not a DNS override. Casimir does not include an identity
  provider.
- A clean product source checkout, Git, Bash, Docker and OpenSSL. Safe extraction
  also needs POSIX `sh`, GNU coreutils and tar, plus awk, grep and sed. The
  documented build runs Node, package tooling and application checks in Docker;
  it needs no host Node installation.

Read the [tested support boundary](casimir/install/SUPPORT.md) before using a
different host or application profile.

### Tested profile and current installer restrictions

Validation used Docker Engine **29.9.1** and Compose **5.6.0**. These are the
qualified versions so far; broader compatibility has not been established.
The preview installer currently accepts only that exact pair.

It also rejects hosts with fewer than 2 vCPUs. That conservative check remains
pending one-vCPU validation; it is not an established hardware minimum.

## Build and verify the bundle

From the clean product checkout root, run the build-and-package shell block in
the [source build guide](casimir/install/README.md#clean-source-build-package-and-tests).
The same section also supplies optional contributor tests.
It defaults to `VERSION=c1.0`; use that supported version for this quickstart.
The recipe produces `.local/c1-output/c1.0.tar`, its SHA-256 file and the
matching `c1.0-extract` helper. Keep the bundle and its checksum together.

Run the following in a root shell, setting `OUTPUT_DIR` to the absolute
`.local/c1-output` path in the source checkout:

```sh
set -eu
BUNDLE_DIR="${BUNDLE_DIR:-/opt/casimir/c1.0}"
OUTPUT_DIR="$PWD/.local/c1-output"
ARCHIVE="$OUTPUT_DIR/c1.0.tar"
EXPECTED_SHA256="$(cat "$ARCHIVE.sha256")"
mkdir -p "$(dirname "$BUNDLE_DIR")"
test ! -e "$BUNDLE_DIR"
"$OUTPUT_DIR/c1.0-extract" "$ARCHIVE" "$EXPECTED_SHA256" "$BUNDLE_DIR"
cd "$BUNDLE_DIR"
./casimir bundle verify
```

Use `/opt/casimir/c1.0` as `BUNDLE_DIR` by default. Choose a different new
absolute directory when that path is already in use.

The checksum detects transfer or storage changes; it does not identify a
publisher. For a transferred bundle, obtain its checksum through a trusted
channel. Keep state and private configuration outside the bundle directory.

## Configure, install and enroll

Create the operator TLS configuration, OIDC configuration and separate OIDC
secrets file using the exact examples in the
[operator installation guide](casimir/install/README.md#installation-and-tls).
Use absolute paths to the certificate, key and CA files. Set `controlOrigin`,
`appOrigin`, ports and `bindAddress` to values reachable by your operators,
browser and developer container. Keep the configuration and secret files
private with mode `0600`; keep them outside the checkout, bundle and state.
The public CA certificate is not secret and must be readable by the SDK container
running as UID 1000 (for example, mode `0644`); keep the private key and all
credentials at `0600`.

For a private IdP address or CA, also provide the `--identity-policy` file; its
schema is in the [installation walkthrough](docs/casimir-walkthrough/INSTALLATION.md#verify-the-release-and-prepare-private-configuration).
The policy grants IdP access to the API only. Do not pass Cloudflare access
settings or application secrets as a substitute for an OIDC setup.

Run the following as the root Docker operator from the extracted bundle. The
state path must be new and otherwise empty:

```sh
BUNDLE_DIR="${BUNDLE_DIR:-/opt/casimir/c1.0}"
cd "$BUNDLE_DIR"
./casimir install --state /var/lib/casimir/operator --config /private/config/config.json
./casimir auth-setup --state /var/lib/casimir/operator --auth-config /private/config/auth.json --auth-secrets /private/config/auth-secrets.json
./casimir status --state /var/lib/casimir/operator
```

If required for the IdP, append
`--identity-policy /private/config/identity-policy.json` to `auth-setup`.
Open the setup URL printed by that command, enter its one-time bootstrap code
only on the trusted control origin, and complete the OIDC administrator setup.
Treat the pending code as a credential and keep command logs outside `--state`.
After enrollment, status must report `outcome: "ready"`; before any app is
published, `code: "ready_to_deploy"` is expected. A zero command exit alone does
not prove readiness.

## Publish the bundled notes app

The install state file `api.env` contains both a database URL and the SDK token.
Extract only `CASIMIR_TOKEN` to a private publisher environment file; do not
copy or mount `api.env`, the state directory, server configuration or the Docker
socket into a developer container. The example below writes only the token and
control URL to a root-only file:

```sh
set -eu
STATE=/var/lib/casimir/operator
CONTROL_ORIGIN=https://control.example.test:4485
CLIENT_ENV=/root/.config/casimir/client.env
mkdir -p /root/.config/casimir
chmod 700 /root/.config/casimir
TOKEN="$(awk -F= '$1 == "CASIMIR_TOKEN" { n++; token = substr($0, index($0, "=") + 1) } END { if (n != 1 || token == "") exit 1; print token }' "$STATE/api.env")"
(umask 077; printf 'CASIMIR_API_URL=%s\nCASIMIR_TOKEN=%s\n' "$CONTROL_ORIGIN" "$TOKEN" > "$CLIENT_ENV")
unset TOKEN
chmod 600 "$CLIENT_ENV"
```

Run the packed SDK in a Docker developer container on a network that can reach
both HTTPS origins. This uses writable copies of the bundled app and both
prepared dependency caches, while keeping the image's default home directory.
The developer container must resolve the control and app hostnames; host
`/etc/hosts` entries are not inherited. Set `PUBLIC_CA` to the public CA
certificate used by the TLS configuration. Run from the extracted bundle
directory on a Docker host where its tooling image has been loaded by installation:

```sh
set -eu
BUNDLE_DIR="${BUNDLE_DIR:-/opt/casimir/c1.0}"
cd "$BUNDLE_DIR"
TOOLING_IMAGE="$(sed -n '2p' bootstrap.txt)"
PUBLIC_CA=/private/config/ca.pem
docker run --rm --pull=never --network bridge \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 512 \
  --env-file /root/.config/casimir/client.env \
  --env NODE_EXTRA_CA_CERTS=/run/certs/casimir-ca.pem \
  --mount "type=bind,src=$PWD/reference-app,dst=/bundle/reference-app,readonly" \
  --mount "type=bind,src=$PUBLIC_CA,dst=/run/certs/casimir-ca.pem,readonly" \
  --tmpfs /workspace:rw,exec,nosuid,nodev,size=3g,uid=1000,gid=1000,mode=0700 \
  --entrypoint sh -i "$TOOLING_IMAGE" -s <<'CLIENT'
set -eu
mkdir -p /workspace/app /workspace/store /workspace/cache
cp -R /bundle/reference-app/. /workspace/app/
cp -R /opt/casimir-client-store/. /workspace/store/
cp -R /home/node/.cache/pnpm-client/. /workspace/cache/
export PNPM_CONFIG_STORE_DIR=/workspace/store
export PNPM_CONFIG_CACHE_DIR=/workspace/cache
cd /workspace/app
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm rebuild better-sqlite3
# The notes example declares this server-only setting; use synthetic data.
printf 'SERVER_ONLY=preview-example\n' > .env
pnpm exec void connect --platform casimir "$CASIMIR_API_URL"
pnpm exec void deploy --project casimir-reference
CLIENT
```

`void connect` must use the same HTTPS control origin as `CASIMIR_API_URL`.
The cache supports the bundled reference app's pinned dependency graph; it does
not prepare arbitrary new dependencies. The published notes app uses the fixed
Node/SQLite profile in the support boundary.

Open `appOrigin` in a browser that trusts the configured CA. Save a synthetic
note and refresh the page; the note should remain visible. Then check status:

```sh
BUNDLE_DIR="${BUNDLE_DIR:-/opt/casimir/c1.0}"
cd "$BUNDLE_DIR"
./casimir status --state /var/lib/casimir/operator
```

Require `outcome: "ready"`, `code: "serving_verified"`, and a fresh
`servingObservation`. The app URL is the configured `appOrigin`.

The [full operator guide](casimir/install/README.md) documents lifecycle,
backup, restore and compatible upgrade commands. This preview is not a
multiuser platform, arbitrary-code security boundary or production certification.
