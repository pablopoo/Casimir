# Contributing to Casimir

Casimir is a developer preview of a self-hosted adaptation of Void. Contributions
should preserve the SDK publishing experience while making the backend usable
on a controlled internal server. Broader feature parity remains unfinished.

- Use the [source build and verification guide](casimir/install/README.md#clean-source-build-package-and-tests).
- Read the [support boundary](casimir/install/SUPPORT.md) before changing lifecycle behavior.
- Use [TESTING.md](TESTING.md) for framework/package testing details.

Run application builds, servers and tests in Docker. Keep dependencies locked
and record the image/source versions used. Run affected tests and package
typechecks first; record failures and skipped checks accurately. The historical
full upstream suite is not claimed green by this preview.

Use synthetic data and disposable, clearly named resources. Keep credentials,
private configuration, state directories, backups and caches outside Git.
Preserve existing volumes and other projects' services. Cleanup should target
only your own discarded resources; do not use global pruning.

Describe the observed problem, resulting behavior and checks you ran. Include
an example another developer can reproduce without your server or credentials.
Screenshots should show the actual product with synthetic data. Avoid unrelated
renames and changes to SDK package names.

Installation reports should include OS/architecture, Docker driver/versions,
bundle source revision and sanitized outcome code. Remove tokens, setup codes,
callback queries, usernames and private infrastructure addresses from attachments.
Never post an unredacted environment, credential or database.

Preserve MIT and third-party notices when adapting code/assets. Package
namespaces still belong to their upstream projects; this snapshot does not
authorize publishing packages into those namespaces. Inherited automatic
deployment/publication workflows are absent from this preparation.
