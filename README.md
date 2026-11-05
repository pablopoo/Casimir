# Casimir

Casimir is an experimental self-hosted platform for publishing internal apps
with the Void SDK and managing them through the reused platform console.
It runs its tested Node/SQLite application profile on a Linux Docker server.

**Status: developer preview.** The bounded install → SDK deployment → browser
write → app update → backup → independent restore → compatible upgrade workflow
has been exercised. Full Void feature parity, multiuser operation, arbitrary
applications and production readiness are still open. The latest Casimir branding
passed focused source checks; its fresh standalone build/UI qualification is
pending. This source snapshot does not include a prebuilt release.

## Install on your own server

1. Build a standalone bundle using the [source build guide](casimir/install/README.md#clean-source-build-package-and-tests).
2. Verify it and configure HTTPS on separate control and application hostnames.
3. Follow the [operator guide](casimir/install/README.md#installation-and-tls), configure your OIDC provider, and enroll the administrator.
4. Publish the bundled notes example with the packed fork SDK, then open its app URL and console.

The operator profile is Linux amd64 with rootful Docker, classic `overlay2`
storage and Compose. Follow the exact [support boundary](casimir/install/SUPPORT.md).
Source builds need more resources than a running app. Application tooling,
builds and tests run in Docker; the documented workflow needs no host Node install.

From the built bundle, the basic operator commands are:

```sh
./casimir bundle verify
./casimir install --state /var/lib/casimir/operator --config /private/config/config.json
./casimir auth-setup --state /var/lib/casimir/operator --auth-config /private/config/auth.json --auth-secrets /private/config/auth-secrets.json
./casimir status --state /var/lib/casimir/operator
```

Create the referenced private files for your own installation, outside this
checkout and bundle. The [full guide](casimir/install/README.md) supplies their
schemas, identity-policy option and lifecycle instructions. After enrollment,
use browser sign-in; do not rerun `auth-setup` as a status or update command.

## Source and contributions

This snapshot includes the Casimir adapter, installer, reference app, reused
management components, SDK/framework source, tests and usage documentation.
SDK names remain `void` and `@void/*`. Original framework docs under `docs/`
also describe Cloudflare features; Casimir's operator/support guides define
this preview's self-hosted scope. The optional upstream account dashboard
remains a separate surface with incomplete Casimir qualification.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [TESTING.md](TESTING.md).
Use synthetic examples; never attach real credentials, dumps or private server
information to issues. Automatic deployment/publication workflows are absent.

## Attribution and license

Based on [Void](https://github.com/voidzero-dev/void), originally examined at
version1.1.11, revision `a38b1f874e16e52a9b32539163f80f2ba6c6b966`.
The original [MIT license](LICENSE) and third-party notices are retained.
Adapted syntax-highlighting theme notices remain in
[their source directory](platform/packages/api/src/admin/react/themes/LICENSE)
and are included by the standalone packager. Casimir branding does not imply
upstream endorsement. [SOURCE-PROVENANCE.json](SOURCE-PROVENANCE.json) identifies
the product source used for this preparation.
