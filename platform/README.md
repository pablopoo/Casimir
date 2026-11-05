# Platform source

Casimir reuses Void's platform interfaces and domain code with a self-hosted
Node/PostgreSQL control adapter and a fixed Docker application runtime.
Start with the [Casimir operator guide](../casimir/install/README.md) and
[support boundary](../casimir/install/SUPPORT.md).

The Casimir adapter is in `packages/api/src/casimir/`; the original operational
console is in `packages/api/src/admin/`. The optional account dashboard is a
separate component and is not fully qualified on Casimir. Other upstream Worker
sources remain for framework compatibility; their presence is not a Casimir
feature-parity claim.

Use [CONTRIBUTING.md](../CONTRIBUTING.md) and [TESTING.md](../TESTING.md) for
contribution and verification guidance. Run builds, application tooling and tests
in Docker. Keep real installation state and credentials outside this checkout.
Inherited hosted-service deployment descriptors, automatic publication workflows
and internal maintainer/design records are omitted from this preparation.
