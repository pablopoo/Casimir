# Evidence and scope

The illustrated journey follows one controlled Casimir installation and its SDK
notes app. The console is adapted from Void and displays Casimir branding.
The captures were taken on 2026-11-05 from the running product, with synthetic accounts,
project names, addresses and note contents.

## What this journey demonstrates

Administrator setup, real HTTPS OIDC sign-in, administrator confirmation,
SDK publishing, browser writes, an app update preserving those notes, and the
Dashboard, Projects and Deployments views for that same app. The source and
build used for the captures are recorded in `CAPTURE-MANIFEST.json`.

The identity provider is a synthetic protocol fixture. This checks the actual
OIDC flow; it does not qualify a particular company's identity provider.
Traffic metrics are unavailable. Other console controls and the optional
account dashboard retain their separate implementation and verification work.

An earlier lifecycle trial also exercised encrypted backup, independent restore
and one compatible platform upgrade. Those checks were not repeated for the
branding pass, and these new screenshots are not evidence of a platform upgrade.

## Images and privacy

Image bytes are unchanged. The capture manifest records their dates, sizes and
SHA-256 hashes. The guide excludes real personal details, private server
addresses, Linux usernames, machine paths, setup codes, cookies, tokens,
callback queries and private keys. Visible demonstration identities are fictional.
No credentials or release binaries are included in this illustrated folder.

## Limits

This is a developer preview with one trusted operator, one project and the
bundled Node/SQLite notes example. Full Void parity, multiuser operation,
arbitrary application compatibility and production readiness remain open.
Docker shares the host kernel; this is not a hostile-code isolation claim.
The pinned test environment does not qualify newer Docker versions or prove
host-reboot behavior. Follow the product support guide for exact versions.

This offline guide is unpublished and does not promise a reachable live demo.

## Developer-tooling qualification

The initial SDK deployment used a source-built runtime-toolchain container; the
update used the bundled tooling image with the same existing workspace. A
separate fresh check passed using only the shipped image, bundle app and writable
copies of its caches, with networking disabled and no credentials: frozen install
verified 11,770 files and the native SQLite smoke query passed. The earlier
direct-cache profile failed; use the verified copied-cache recipe in the product
guide. This qualification covers the fixed reference-app graph only.
Use the exact product source/build guide and support boundary.

The offline HTML was checked at desktop (1440px) and mobile (390px) widths:
all eight images loaded, with no horizontal page overflow, cookies, page errors
or console errors. The report uses only local styles and image assets.
