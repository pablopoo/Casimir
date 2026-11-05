# Install the private preview

Use a controlled server and a reviewed standalone bundle built from this source,
following the product’s `casimir/install/README.md` source build guide.
This walkthrough is an offline report; its folder does not contain the release
archive, certificates, identity-provider credentials or operator credentials.
This source preparation does not supply a public prebuilt release.

## Prepare the server and addresses

The qualified profile is Linux amd64, rootful Docker Engine **29.9.1**, Compose
**5.6.0**, classic **overlay2** image storage, at least 2 CPUs, 8 GiB RAM and
20 GiB free disk, with additional room for bundles and backups. Use the release
README for the exact preflight and image-store requirements. An existing
Docker installation needs its own migration plan before changing image stores.
No host Node installation or source build is required to use the bundle.

Arrange two HTTPS hostnames resolving to the server: one for the console and
one for apps. Use certificates trusted by the operator and browsers. Two ports
on the same hostname do not satisfy the console’s cookie isolation requirement.

Register the console’s `/auth/callback` URL with the company OIDC provider.
The report uses `control.example.test`, `app.example.test` and a synthetic IdP;
replace demonstration addresses and client settings with your own.

## Verify the release and prepare private configuration

Use the supplied safe extractor and the archive SHA256 supplied through a
trusted channel. Follow the filenames and extraction command in that release’s
README, then change into the extracted bundle directory and run:

```sh
./casimir bundle verify
```

Prepare the operator TLS configuration, certificates, Void authentication JSON
and separate client-secret JSON as described in the bundled README. The operator
config contains the console/app origins, server bind address, ports and
certificate paths. Keep private inputs outside the installation state directory.
Authentication and secrets files must be regular private files with mode 0600.

The OIDC authentication configuration uses these existing Void fields:

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

The separate secrets file maps `OIDC_CLIENT_SECRET` to the real client secret;
no secret is included here. Private IdP addresses or a private CA require the
explicit `--identity-policy` file documented by the release. This policy grants
identity access to the API only, not to applications. Its shape is:

```json
{
  "origins": [{
    "origin": "https://idp.example.com",
    "addresses": ["replace-with-idp-server-ip"],
    "caPem": "replace-with-public-CA-PEM"
  }]
}
```

Replace every placeholder. Use the IdP’s actual hostname and allowed server
addresses; omit `caPem` when its certificate already uses a trusted public CA.
The PEM value is a public CA certificate, never its private key.

## Install and enroll the administrator

Run as the local root Docker operator, from the verified extracted bundle.
These are the supported commands; the paths below are portable examples.
The initial state directory must be otherwise empty. Keep transcripts outside
it; setup output contains a credential.

```sh
./casimir install --state /var/lib/casimir/operator --config /private/config/config.json
./casimir auth-setup --state /var/lib/casimir/operator --auth-config /private/config/auth.json --auth-secrets /private/config/auth-secrets.json
./casimir status --state /var/lib/casimir/operator
```

When a private IdP policy is required, add its private file to the setup command:

```sh
./casimir auth-setup --state /var/lib/casimir/operator --auth-config /private/config/auth.json --auth-secrets /private/config/auth-secrets.json --identity-policy /private/config/identity-policy.json
```

Use one applicable setup command, then open the printed setup URL, enter its
private code, sign in with the company provider and review/confirm the first
administrator. If setup is interrupted while pending, use the release’s resume
instructions. After completion, use normal browser sign-in; `auth-setup` is not
a status or provider-update command.

A usable status must report `outcome: ready`; serving an app additionally needs
`code: serving_verified` and a fresh serving observation. Preserve the state
path, named volumes, exact bundle and protected backups. The bundled README
contains supported stop/start, backup, restore and compatible-upgrade commands.

Continue with the [user walkthrough](WALKTHROUGH.md). This controlled proof does
not qualify production use, arbitrary apps, host reboot or full feature parity.
