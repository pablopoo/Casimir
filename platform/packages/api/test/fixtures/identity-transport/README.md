# Node identity transport fixture

This isolated fixture exercises the Node transport against a real HTTPS IdP.
It expects two containers on a new internal-only Docker network: the IdP has
aliases `idp.example.com` and `wrong-idp.example.com` and a synthetic
certificate for `idp.example.com`; the client runs the bundled `client.mjs`.
Keep the fixture on non-loopback RFC1918 address space and do not publish ports.

Generate the synthetic CA and leaf certificate inside the IdP container's RAM
work directory with `sh prepare-certs.sh /work`, then start `idp.mjs` with the
generated key and certificate. The leaf has the `idp.example.com` SAN. The
client receives only the CA certificate, never the private keys.

Run this build inside the Node 24 Docker workspace, from the Void repository
root (the fixture and application sources must be in the same checkout):

```sh
node platform/packages/api/test/fixtures/identity-transport/build.mjs /work/identity-transport
```

The client reads the IdP's RFC1918 address on its first stdin line and the PEM
CA certificate on the remaining lines. It reports only request counts and
bounded-response outcomes. `idp.mjs` requires a signed leaf key/certificate at
the paths passed as arguments (defaults are `/work/idp-key.pem` and
`/work/idp-cert.pem`) and writes request paths/counts to its log path.

The assertions prove that the default public policy rejects the reachable
private IdP before a request effect, missing/wrong CA and a listed wrong-hostname
origin fail certificate verification, and the exact origin/address/CA policy
connects with hostname verification. A redirect is rejected without following
its target. The fixture covers raw, chunked and gzip-compressed responses whose
decoded bodies exceed 256 KiB. It does not exercise full OIDC discovery or
operator login.
