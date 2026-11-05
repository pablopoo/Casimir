import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const installationId = 'a'.repeat(32);
const operatorId = 'user_abcdefghijkl';
const projectId = 'proj_abcdefghijkl';
const operationalStatePath = '/srv/casimir/source state';
const identityPolicy = {
  origins: [{ origin: 'https://idp.example.com', addresses: ['10.24.8.3'] }],
};
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'b'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
const config = {
  format: 1,
  mode: 'external-tls',
  controlOrigin: 'https://control.example.test:4485',
  appOrigin: 'https://app.example.test:4486',
  bindAddress: '127.0.0.1',
  controlPort: 4485,
  appPort: 4486,
  certificatePaths: { ca: '/state/tls-ca.pem' },
};
const owner = {
  format: 1,
  installationId,
  ownershipNonce: 'n'.repeat(48),
  jwtSecret: 'f'.repeat(64),
  authSetupToken: '1'.repeat(64),
  projectSecretKeysJson: JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') }),
  projectSecretActiveKeyVersion: '1',
  operatorId,
  projectId,
  identityNetwork: identityPolicy,
};
const state = '/state';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function writePrivate(path, value) {
  const contents = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function stageApiReaderFiles() {
  assert.equal(process.getuid(), 1000, 'API-readable fixtures must be created by UID 1000');
  const files = {
    'management.json': owner,
    'profile.json': {
      runtime,
      artifactRoot: '/state/artifacts',
      installationId,
      origins: { control: config.controlOrigin, app: config.appOrigin },
      externalTls: { controlPort: config.controlPort, appPort: config.appPort },
    },
    'runner.json': { runtime, imageId: `sha256:${'2'.repeat(64)}` },
    'tls-ca.pem': 'synthetic CA bytes; transport is injected in this metadata fixture\n',
  };
  for (const [name, value] of Object.entries(files)) {
    const contents = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
    await writeFile(join(state, name), contents, { flag: 'wx', mode: 0o600 });
    await chmod(join(state, name), 0o600);
  }
  console.log(JSON.stringify({ stagedApiReaderFiles: Object.keys(files).sort(), uid: process.getuid() }));
}

function runJson(entry, args) {
  const child = spawnSync(process.execPath, [entry, ...args], {
    cwd: '/work/void',
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, `${entry} could not execute`);
  assert.equal(child.status, 0, `${entry} exit ${child.status}; stderr=${child.stderr}`);
  return JSON.parse(child.stdout.trim());
}

const stageMode = process.argv.includes('--stage-api-reader-files');
if (stageMode) {
  await stageApiReaderFiles();
} else {
  const { default: test } = await import('node:test');

  test('fixed root reader validates legacy and pending states, then captures and decrypts the exact checkpoint', {
    skip: process.env.CASIMIR_RUN_STATE_READER_CAPTURE !== '1',
  }, async () => {
    const { authSetup } = await import('../../dist/authSetup.mjs');
    const { managementKeyFingerprint, validateAuthSetupCheckpoint } =
      await import('../../dist/managementCheckpoint.mjs');
    const { deriveResources } = await import('../../../platform/packages/api/src/casimir/lifecycle/resources.ts');
    const { readEncryptedBackup } = await import('../../../platform/packages/api/src/casimir/lifecycle/backup-format.ts');
    const { rewriteAuthSetupStatePath } = await import('../management-state.mjs');
    assert.equal(process.getuid(), 0, 'reader fixture must run as root');
    const status = await readFile('/proc/self/status', 'utf8');
    assert.equal(BigInt(`0x${status.match(/^CapEff:\s+([a-f0-9]+)$/m)?.[1]}`), 0x4n);
    assert.equal((await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0');
    const initialFiles = (await readdir(state)).sort();
    assert.deepEqual(initialFiles, ['management.json', 'profile.json', 'runner.json', 'tls-ca.pem']);
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(join(state, 'management.json'))).uid, 1000);
    assert.equal((await stat(join(state, 'management.json'))).mode & 0o777, 0o600);

    const identity = {
      format: 1,
      installationId,
      token: 'c'.repeat(64),
      databasePassword: 'd'.repeat(64),
      config,
      bundleVersion: 'c1.0',
      bundleHash: 'e'.repeat(64),
    };
    const receipt = {
      format: 1,
      installationId,
      bundleVersion: identity.bundleVersion,
      bundleHash: identity.bundleHash,
      operatorId,
      projectId,
      phase: 'ready',
      resources: deriveResources(installationId),
    };
    const apiEnvPath = join(state, 'api.env');
    const initialApiEnv = [
      'PORT=3000',
      'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
      'CASIMIR_MANAGEMENT_ENABLED=false',
    ].join('\n') + '\n';
    await Promise.all([
      writePrivate(join(state, 'identity.json'), identity),
      writePrivate(join(state, 'receipt.json'), receipt),
      writePrivate(join(state, 'management-owner.json'), owner),
      writePrivate(join(state, 'api.env'), initialApiEnv),
      writePrivate(join(state, 'compose.json'), {
        services: {
          api: {
            networks: ['runtime'],
            volumes: [{
              type: 'bind', source: join(state, 'management.json'),
              target: '/config/management.json', read_only: true,
            }],
          },
        },
        networks: { runtime: { internal: true } },
      }),
      writePrivate(join(state, 'runtime-env.json'), { FIXTURE: 'synthetic' }),
    ]);

    const authConfigPath = '/work/auth.json';
    const authSecretsPath = '/work/secrets.json';
    const identityPolicyPath = '/work/identity-policy.json';
    const authConfig = {
      administratorConnectionId: 'company',
      connections: [{
        clientSecretEnv: 'OIDC_SECRET',
        configuration: {
          id: 'company', kind: 'oidc', label: 'Company', clientId: 'synthetic-client',
          issuer: 'https://idp.example.com', allowedDomains: [], requiredGroups: [],
        },
      }],
    };
    const authSecrets = { OIDC_SECRET: 'synthetic-only-secret' };
    const authConfigText = `${JSON.stringify(authConfig)}\n`;
    const authSecretsText = `${JSON.stringify(authSecrets)}\n`;
    const identityPolicyText = `${JSON.stringify(identityPolicy)}\n`;
    await Promise.all([
      writePrivate(authConfigPath, authConfigText),
      writePrivate(authSecretsPath, authSecretsText),
      writePrivate(identityPolicyPath, identityPolicyText),
    ]);

    const authResult = await authSetup(state, { authConfigPath, authSecretsPath, identityPolicyPath }, {
      assertInstallResourcesOwned: () => undefined,
      docker: () => undefined,
      inspectControlIngressRequestTarget: async () => ({
        hostname: '127.0.0.1', port: config.controlPort,
        host: new URL(config.controlOrigin).host,
        servername: new URL(config.controlOrigin).hostname,
        externalTls: true,
      }),
      createAuthSetupFetch: async () => async (_url, _init) => new Response(
        JSON.stringify({ setupPending: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });
    assert.equal(authResult.status, 'pending');
    assert.equal(authResult.setupPending, true);
    assert.equal(typeof authResult.authBootstrapCode, 'string');
    const checkpointPath = join(state, 'auth-setup-checkpoint.json');
    const checkpointBytes = await readFile(checkpointPath);
    const checkpoint = JSON.parse(checkpointBytes);
    assert.equal((await stat(checkpointPath)).uid, 0);
    assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(state, 'management-owner.json'))).uid, 0);
    assert.equal((await stat(join(state, 'management-owner.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(state, 'management.json'))).uid, 1000);
    assert.equal((await stat(join(state, 'management.json'))).mode & 0o777, 0o600);

    const validatedCheckpoint = validateAuthSetupCheckpoint(checkpoint, owner, identity);
    assert.equal(checkpoint.installationId, identity.installationId);
    assert.equal(checkpoint.keyFingerprint, managementKeyFingerprint(owner));
    assert.equal(checkpoint.authConfigHash, sha256(authConfigText));
    assert.equal(checkpoint.authSecretsHash, sha256(authSecretsText));
    assert.equal(checkpoint.identityPolicyHash, sha256(identityPolicyText));
    assert.deepEqual(checkpoint.previousIdentityNetwork, identityPolicy);
    assert.deepEqual(checkpoint.identityNetwork, identityPolicy);
    assert.equal(checkpoint.requestHash.length, 64);
    assert.equal(checkpoint.authBootstrapCode === authResult.authBootstrapCode, true);
    assert.equal(JSON.parse(checkpoint.authenticationSetupJson).bootstrapCredentialHash, sha256(checkpoint.authBootstrapCode));
    assert.equal(validatedCheckpoint.installationId, installationId);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'management-owner.json'), 'utf8')).identityNetwork, identityPolicy);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'management.json'), 'utf8')).identityNetwork, identityPolicy);
    const authSetupEnv = await readFile(apiEnvPath, 'utf8');
    const encodedViewPath = Buffer.from(state, 'utf8').toString('base64');
    assert.equal(authSetupEnv.includes('CASIMIR_MANAGEMENT_ENABLED=true\n'), true);
    assert.equal(authSetupEnv.includes(`CASIMIR_AUTH_SETUP_STATE_B64=${encodedViewPath}\n`), true);
    const encodedSourcePath = Buffer.from(operationalStatePath, 'utf8').toString('base64');
    const activeEnv = rewriteAuthSetupStatePath(authSetupEnv, operationalStatePath);
    const expectedActiveEnv = authSetupEnv.replace(
      `CASIMIR_AUTH_SETUP_STATE_B64=${encodedViewPath}`,
      `CASIMIR_AUTH_SETUP_STATE_B64=${encodedSourcePath}`,
    );
    assert.equal(activeEnv, expectedActiveEnv);
    assert.equal(Buffer.from(encodedSourcePath, 'base64').toString('utf8'), operationalStatePath);
    await writePrivate(apiEnvPath, activeEnv);
    assert.deepEqual(await readFile(checkpointPath), checkpointBytes);

    const preflight = async (expectedPath = operationalStatePath) => runJson(
      'casimir/install/management-state-preflight.mjs', [expectedPath],
    );
    const checks = [];
    let result = await preflight();
    assert.deepEqual(result, { validated: true });
    checks.push({ name: 'valid_pending', validated: true });

    await writePrivate(checkpointPath, { format: 1 });
    result = await preflight();
    assert.deepEqual(result, { validated: false, code: 'management_auth_setup_checkpoint_conflict' });
    checks.push({ name: 'malformed_checkpoint', code: result.code });
    await writeFile(checkpointPath, checkpointBytes, { mode: 0o600 });

    result = await preflight('relative/source state');
    assert.deepEqual(result, { validated: false, code: 'management_auth_setup_state_path' });
    checks.push({ name: 'invalid_expected_path', code: result.code });

    await writePrivate(apiEnvPath, activeEnv.replace(
      `CASIMIR_AUTH_SETUP_STATE_B64=${encodedSourcePath}`,
      `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from('/srv/casimir/wrong state').toString('base64')}`,
    ));
    result = await preflight();
    assert.deepEqual(result, { validated: false, code: 'management_auth_setup_state_path' });
    checks.push({ name: 'expected_path_conflict', code: result.code });
    await writePrivate(apiEnvPath, activeEnv);

    const snapshotBytes = Buffer.from('synthetic SQLite snapshot payload\n');
    const snapshotPath = '/snapshots/synthetic.sqlite';
    const snapshotHash = sha256(snapshotBytes);
    await mkdir('/artifacts', { recursive: true });
    await mkdir('/runtime', { recursive: true });
    await mkdir('/routes', { recursive: true });
    await mkdir('/key', { recursive: true });
    await writePrivate('/capture/control.dump', 'synthetic opaque database dump\n');
    await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
    await writePrivate('/routes/route.conf', 'synthetic route fixture\n');
    await writeFile('/key/backup.key', Buffer.alloc(32, 9), { mode: 0o600 });
    await chmod('/key/backup.key', 0o600);
    await writePrivate('/capture/descriptor.json', {
      format: 1,
      installationId,
      bundleVersion: identity.bundleVersion,
      bundleHash: identity.bundleHash,
      recordId: 'backup_synthetic_01',
      snapshot: { path: 'synthetic.sqlite', sha256: snapshotHash },
      artifacts: [],
      operations: [],
    });

    const captured = runJson('casimir/install/capture.mjs', [operationalStatePath]);
    assert.equal(captured.verified, true);
    assert.equal(captured.installationId, installationId);
    assert.equal(captured.recordId, 'backup_synthetic_01');
    const decrypted = await readEncryptedBackup(
      '/capture/result.backup', '/key/backup.key', '/capture/independent-decryption',
    );
    const archivedCheckpointPath = '/capture/independent-decryption/files/state/auth-setup-checkpoint.json';
    const decryptedCheckpointBytes = await readFile(archivedCheckpointPath);
    assert.deepEqual(decryptedCheckpointBytes, checkpointBytes);
    const archivedOwner = JSON.parse(await readFile('/capture/independent-decryption/files/state/management-owner.json', 'utf8'));
    const archivedApiConfig = JSON.parse(await readFile('/capture/independent-decryption/files/state/management.json', 'utf8'));
    const archivedCheckpoint = JSON.parse(decryptedCheckpointBytes);
    assert.deepEqual(archivedOwner.identityNetwork, identityPolicy);
    assert.deepEqual(archivedApiConfig.identityNetwork, identityPolicy);
    assert.deepEqual(archivedCheckpoint.previousIdentityNetwork, identityPolicy);
    assert.deepEqual(archivedCheckpoint.identityNetwork, identityPolicy);
    const checkpointEntry = decrypted.files.find((file) => file.path === 'state/auth-setup-checkpoint.json');
    assert.deepEqual(checkpointEntry, {
      path: 'state/auth-setup-checkpoint.json',
      bytes: checkpointBytes.length,
      sha256: sha256(checkpointBytes),
    });
    assert.equal(decrypted.metadata.installationId, installationId);
    assert.equal(decrypted.metadata.bundleVersion, identity.bundleVersion);
    assert.equal(decrypted.metadata.references.includes('state/auth-setup-checkpoint.json'), true);
    assert.equal((await stat(archivedCheckpointPath)).uid, 0);
    assert.equal((await stat(archivedCheckpointPath)).mode & 0o777, 0o600);
    const restoredApiEnv = await readFile('/capture/independent-decryption/files/state/api.env', 'utf8');
    const targetStatePath = '/srv/casimir/restored state';
    const rewrittenApiEnv = rewriteAuthSetupStatePath(restoredApiEnv, targetStatePath);
    const expectedRewrittenApiEnv = restoredApiEnv.replace(
      `CASIMIR_AUTH_SETUP_STATE_B64=${encodedSourcePath}`,
      `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(targetStatePath, 'utf8').toString('base64')}`,
    );
    assert.equal(rewrittenApiEnv, expectedRewrittenApiEnv);
    assert.equal(rewrittenApiEnv.includes('CASIMIR_MANAGEMENT_ENABLED=true\n'), true);
    const encodedTargetPath = Buffer.from(targetStatePath, 'utf8').toString('base64');
    assert.equal(rewrittenApiEnv.includes(`CASIMIR_AUTH_SETUP_STATE_B64=${encodedTargetPath}\n`), true);
    assert.equal(Buffer.from(encodedTargetPath, 'base64').toString('utf8'), targetStatePath);
    checks.push({
      name: 'encrypted_capture_decrypt',
      verified: captured.verified,
      checkpointBytes: checkpointBytes.length,
      checkpointSha256: sha256(checkpointBytes),
      checkpointReferenced: decrypted.metadata.references.includes('state/auth-setup-checkpoint.json'),
      identityPolicyPreserved: archivedOwner.identityNetwork.origins[0].addresses[0] === '10.24.8.3' &&
        archivedApiConfig.identityNetwork.origins[0].origin === 'https://idp.example.com' &&
        archivedCheckpoint.identityNetwork.origins[0].addresses[0] === '10.24.8.3',
      targetPathOnlyRewrite: rewrittenApiEnv === expectedRewrittenApiEnv,
    });

    const unactivatedPairEnv = [
      'PORT=3000',
      'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
      'CASIMIR_MANAGEMENT_ENABLED=false',
    ].join('\n') + '\n';
    await rm(checkpointPath);
    await writePrivate(apiEnvPath, unactivatedPairEnv);
    result = await preflight();
    assert.deepEqual(result, { validated: true });
    checks.push({ name: 'legacy_management_pair_without_activation', validated: true });

    await rm(join(state, 'management-owner.json'));
    await rm(join(state, 'management.json'));
    await writePrivate(apiEnvPath, 'PORT=3000\nCASIMIR_MANAGEMENT_ENABLED=false\n');
    result = await preflight();
    assert.deepEqual(result, { validated: true });
    checks.push({ name: 'legacy_cli_only_without_management_pair', validated: true });

    console.log(JSON.stringify({
      suite: 'task4-state-reader-capture',
      uid: process.getuid(),
      capEff: '0x4',
      swapMax: 0,
      checks,
      captureFiles: captured.files,
    }));
  });
}
