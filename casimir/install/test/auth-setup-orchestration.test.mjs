import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authSetup } from '../../dist/authSetup.mjs';

const installationId = 'a'.repeat(32);
const operatorId = 'user_abcdefghijkl';
const projectId = 'proj_abcdefghijkl';
const controlOrigin = 'https://control.example.test:4485';
const appOrigin = 'https://app.example.test:4486';
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'b'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
const policy = {
  origins: [{ origin: 'https://idp.example.com', addresses: ['10.10.1.8'] }],
};
const authFile = {
  administratorConnectionId: 'company',
  connections: [{
    clientSecretEnv: 'OIDC_SECRET',
    configuration: {
      id: 'company',
      kind: 'oidc',
      label: 'Company',
      clientId: 'synthetic-client',
      issuer: 'https://idp.example.com',
      allowedDomains: [],
      requiredGroups: [],
    },
  }],
};
const secrets = { OIDC_SECRET: 'synthetic-only-secret' };
const responsePending = (expiresAt) => new Response(
  JSON.stringify({ setupPending: true, expiresAt }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const responseComplete = () => new Response(
  JSON.stringify({ setupPending: false }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function deriveFixtureResources(id) {
  const scope = `casimir-${id}`;
  return {
    scope,
    dbContainer: `${scope}-db`,
    executorContainer: `${scope}-executor`,
    appIngressContainer: `${scope}-app-ingress`,
    runtimeNetwork: `${scope}-runtime`,
    appsNetwork: `${scope}-apps`,
    frontNetwork: `${scope}-front`,
    volumes: {
      database: `${scope}-database`,
      artifacts: `${scope}-artifacts`,
      appdata: `${scope}-appdata`,
      snapshots: `${scope}-snapshots`,
      routes: `${scope}-routes`,
      runtimeSecrets: `${scope}-runtime-secrets`,
      jobs: `${scope}-jobs`,
    },
  };
}

async function writePrivate(path, value, uid = 0, gid = 0) {
  const contents = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  await writeFile(path, contents, { mode: 0o600 });
  if (uid !== 0 || gid !== 0) await chown(path, uid, gid);
}

function assertRootRole() {
  assert.equal(process.getuid(), 0, 'this integration profile must run as root');
  const status = readFileSync('/proc/self/status', 'utf8');
  const capEff = status.match(/^CapEff:\s+([a-f0-9]+)$/m)?.[1];
  assert.ok(capEff, 'root capability mask must be observable');
  assert.equal(BigInt(`0x${capEff}`), 0xbn, 'only CHOWN, DAC_OVERRIDE, and FOWNER are enabled');
}

async function createFixture(t) {
  assertRootRole();
  const root = await mkdtemp(join(tmpdir(), 'casimir-auth-setup-orchestration-'));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const authConfigPath = join(root, 'auth.json');
  const authSecretsPath = join(root, 'secrets.json');
  const identityPolicyPath = join(root, 'identity-policy.json');
  await writePrivate(authConfigPath, authFile);
  await writePrivate(authSecretsPath, secrets);
  await writePrivate(identityPolicyPath, policy);

  const config = {
    format: 1,
    mode: 'external-tls',
    controlOrigin,
    appOrigin,
    bindAddress: '127.0.0.1',
    controlPort: 4485,
    appPort: 4486,
    certificatePaths: { ca: join(state, 'tls-ca.pem') },
  };
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
    resources: deriveFixtureResources(installationId),
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
  };
  const profile = {
    runtime,
    artifactRoot: join(state, 'artifacts'),
    installationId,
    origins: { control: controlOrigin, app: appOrigin },
    externalTls: { controlPort: 4485, appPort: 4486 },
  };
  const runner = { imageId: `sha256:${'2'.repeat(64)}`, runtime };
  const compose = {
    services: {
      api: {
        networks: ['runtime'],
        volumes: [{
          type: 'bind',
          source: join(state, 'management.json'),
          target: '/config/management.json',
          read_only: true,
        }],
      },
    },
    networks: {
      runtime: {
        name: `casimir-${installationId}-runtime`,
        internal: true,
        labels: {
          'org.casimir.task': 'c1',
          'org.casimir.installation': installationId,
        },
      },
    },
  };
  const apiEnv = [
    'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
    'CASIMIR_MANAGEMENT_ENABLED=false',
  ].join('\n') + '\n';
  await Promise.all([
    writePrivate(join(state, 'identity.json'), identity),
    writePrivate(join(state, 'receipt.json'), receipt),
    writePrivate(join(state, 'management-owner.json'), owner),
    writePrivate(join(state, 'management.json'), owner, 1000, 1000),
    writePrivate(join(state, 'profile.json'), profile, 1000, 1000),
    writePrivate(join(state, 'runner.json'), runner, 1000, 1000),
    writePrivate(join(state, 'tls-ca.pem'), 'synthetic CA fixture\n', 1000, 1000),
    writePrivate(join(state, 'compose.json'), compose),
    writePrivate(join(state, 'api.env'), apiEnv),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    state,
    authConfigPath,
    authSecretsPath,
    identityPolicyPath,
    owner,
    apiEnv,
  };
}

function dependencies(fixture, respond) {
  const calls = { ownership: 0, inspect: 0, docker: [], posts: [] };
  const deps = {
    assertInstallResourcesOwned: () => { calls.ownership++; },
    docker: (args) => { calls.docker.push([...args]); },
    inspectControlIngressRequestTarget: async () => {
      calls.inspect++;
      return {
        hostname: '127.0.0.1',
        port: 4485,
        host: new URL(controlOrigin).host,
        servername: new URL(controlOrigin).hostname,
        externalTls: true,
      };
    },
    createAuthSetupFetch: async () => async (url, init) => {
      const request = {
        url,
        method: init.method,
        body: String(init.body),
        signature: new Headers(init.headers).get('X-Void-Auth-Setup'),
        redirect: init.redirect,
      };
      calls.posts.push(request);
      return respond(request, calls.posts.length, fixture);
    },
  };
  return { calls, deps };
}

const initialInputs = (fixture) => ({
  authConfigPath: fixture.authConfigPath,
  authSecretsPath: fixture.authSecretsPath,
});

test('auth setup persists the initial checkpoint before its original signed POST and omits code on completion', async (t) => {
  const fixture = await createFixture(t);
  const { calls, deps } = dependencies(fixture, async (request) => {
    const checkpoint = JSON.parse(await readFile(join(fixture.state, 'auth-setup-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.installationId, installationId);
    assert.equal(checkpoint.authBootstrapCode.length, 64);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.url, `${controlOrigin}/internal/platform/auth-initialize`);
    assert.equal(request.body, JSON.stringify(JSON.parse(checkpoint.authenticationSetupJson)));
    assert.equal(typeof request.signature, 'string');
    return responseComplete();
  });
  const result = await authSetup(fixture.state, initialInputs(fixture), deps);
  assert.deepEqual(Object.keys(result).sort(), ['setupPending', 'status']);
  assert.equal(result.status, 'complete');
  assert.equal(result.setupPending, false);
  assert.equal(calls.posts.length, 1);
  const activatedCompose = JSON.parse(await readFile(join(fixture.state, 'compose.json'), 'utf8'));
  assert.equal(activatedCompose.networks['identity-egress'].name, `casimir-${installationId}-identity-egress`);
  assert.equal(activatedCompose.services.api.networks.includes('identity-egress'), true);
  for (const [name, service] of Object.entries(activatedCompose.services)) {
    if (name === 'api') continue;
    assert.equal((service.networks ?? []).includes('identity-egress'), false, `${name} must not receive identity egress`);
  }
  assert.equal(activatedCompose.services.api.ports, undefined);
  for (const service of Object.values(activatedCompose.services)) {
    const mounts = service.volumes ?? [];
    assert.equal(mounts.some((volume) => JSON.stringify(volume).includes('auth-setup-checkpoint')), false);
    assert.equal(mounts.some((volume) => JSON.stringify(volume).includes('auth.json')), false);
    assert.equal(mounts.some((volume) => JSON.stringify(volume).includes('secrets.json')), false);
  }
  await assert.rejects(readFile(join(fixture.state, 'auth-setup-checkpoint.json')), { code: 'ENOENT' });
});

test('a failed initial checkpoint write causes zero setup POSTs and preserves the previous files', async (t) => {
  const fixture = await createFixture(t);
  const ownerBefore = await readFile(join(fixture.state, 'management-owner.json'));
  const apiBefore = await readFile(join(fixture.state, 'management.json'));
  const envBefore = await readFile(join(fixture.state, 'api.env'));
  const { calls, deps } = dependencies(fixture, async () => responseComplete());
  deps.persistCheckpoint = async () => { throw new Error('synthetic checkpoint write failure'); };
  await assert.rejects(
    authSetup(fixture.state, initialInputs(fixture), deps),
    /synthetic checkpoint write failure/,
  );
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.docker.length, 0);
  assert.deepEqual(await readFile(join(fixture.state, 'management-owner.json')), ownerBefore);
  assert.deepEqual(await readFile(join(fixture.state, 'management.json')), apiBefore);
  assert.deepEqual(await readFile(join(fixture.state, 'api.env')), envBefore);
});

test('a lost setup response replays the exact checkpointed request and rejects a changed request hash before effects', async (t) => {
  const fixture = await createFixture(t);
  let firstRequest;
  const first = dependencies(fixture, async (request) => {
    const checkpoint = JSON.parse(await readFile(join(fixture.state, 'auth-setup-checkpoint.json'), 'utf8'));
    assert.equal(request.body, JSON.stringify(JSON.parse(checkpoint.authenticationSetupJson)));
    firstRequest = request;
    throw new Error('synthetic response lost after send');
  });
  await assert.rejects(
    authSetup(fixture.state, initialInputs(fixture), first.deps),
    /synthetic response lost after send/,
  );
  const checkpointPath = join(fixture.state, 'auth-setup-checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const second = dependencies(fixture, async (request) => responseComplete());
  const complete = await authSetup(fixture.state, {}, second.deps);
  assert.equal(firstRequest.body === second.calls.posts[0].body, true);
  assert.equal(firstRequest.signature === second.calls.posts[0].signature, true);
  assert.equal(complete.status, 'complete');
  assert.equal(Object.hasOwn(complete, 'authBootstrapCode'), false);

  await writePrivate(checkpointPath, { ...checkpoint, requestHash: '9'.repeat(64) });
  const rejected = dependencies(fixture, async () => responseComplete());
  const before = {
    ownership: rejected.calls.ownership,
    inspect: rejected.calls.inspect,
    docker: rejected.calls.docker.length,
    posts: rejected.calls.posts.length,
  };
  await assert.rejects(authSetup(fixture.state, {}, rejected.deps), /auth_setup_checkpoint_conflict/);
  assert.equal(rejected.calls.ownership, before.ownership);
  assert.equal(rejected.calls.inspect, before.inspect);
  assert.equal(rejected.calls.docker.length, before.docker);
  assert.equal(rejected.calls.posts.length, before.posts);
});

test('an expired setup checkpoint replacement is durable before the retry POST', async (t) => {
  const fixture = await createFixture(t);
  let firstCode;
  let replacementCode;
  const { calls, deps } = dependencies(fixture, async (request, count) => {
    const checkpoint = JSON.parse(await readFile(join(fixture.state, 'auth-setup-checkpoint.json'), 'utf8'));
    if (count === 1) {
      firstCode = checkpoint.authBootstrapCode;
      return responsePending(new Date(Date.now() - 60_000).toISOString());
    }
    replacementCode = checkpoint.authBootstrapCode;
    const setup = JSON.parse(checkpoint.authenticationSetupJson);
    assert.equal(checkpoint.authBootstrapCode !== firstCode, true);
    assert.equal(setup.bootstrapCredentialHash, sha256(checkpoint.authBootstrapCode));
    assert.equal(request.body, JSON.stringify(setup));
    return responsePending(new Date(Date.now() + 3_600_000).toISOString());
  });
  const result = await authSetup(fixture.state, initialInputs(fixture), deps);
  assert.equal(calls.posts.length, 2);
  assert.equal(result.status, 'pending');
  assert.equal(result.authBootstrapCode === replacementCode, true);
  assert.equal(result.authBootstrapCode === firstCode, false);
});

test('an interrupted identity-policy publication resumes owner-first with an atomic API-reader replacement', async (t) => {
  const fixture = await createFixture(t);
  const oldApiBytes = await readFile(join(fixture.state, 'management.json'));
  const interrupted = dependencies(fixture, async () => responseComplete());
  interrupted.deps.replaceCasimirManagementConfig = async () => {
    throw new Error('synthetic interruption before API rename');
  };
  await assert.rejects(
    authSetup(fixture.state, {
      ...initialInputs(fixture),
      identityPolicyPath: fixture.identityPolicyPath,
    }, interrupted.deps),
    /synthetic interruption before API rename/,
  );
  const ownerAfterInterruption = JSON.parse(await readFile(join(fixture.state, 'management-owner.json'), 'utf8'));
  const apiAfterInterruption = await readFile(join(fixture.state, 'management.json'));
  const checkpoint = JSON.parse(await readFile(join(fixture.state, 'auth-setup-checkpoint.json'), 'utf8'));
  assert.equal(ownerAfterInterruption.identityNetwork.origins[0].origin, policy.origins[0].origin);
  assert.deepEqual(apiAfterInterruption, oldApiBytes);
  assert.equal(checkpoint.previousIdentityNetwork, null);
  assert.equal(interrupted.calls.posts.length, 0);

  const resumed = dependencies(fixture, async () => responseComplete());
  const result = await authSetup(fixture.state, {}, resumed.deps);
  const apiAfterResume = JSON.parse(await readFile(join(fixture.state, 'management.json'), 'utf8'));
  const apiStat = await stat(join(fixture.state, 'management.json'));
  assert.equal(result.status, 'complete');
  assert.equal(apiAfterResume.identityNetwork.origins[0].origin, policy.origins[0].origin);
  assert.equal(apiStat.uid, 1000);
  assert.equal(apiStat.gid, 1000);
  assert.equal(apiStat.mode & 0o777, 0o600);
  assert.equal(resumed.calls.posts.length, 1);
});

test('foreign installation and management-key mismatches are rejected before Docker or network effects', async (t) => {
  const foreign = await createFixture(t);
  const foreignApiPath = join(foreign.state, 'management.json');
  const foreignApi = JSON.parse(await readFile(foreignApiPath, 'utf8'));
  await writePrivate(foreignApiPath, { ...foreignApi, installationId: '9'.repeat(32) }, 1000, 1000);
  const foreignCalls = dependencies(foreign, async () => responseComplete());
  await assert.rejects(authSetup(foreign.state, {}, foreignCalls.deps));
  assert.equal(foreignCalls.calls.ownership, 0);
  assert.equal(foreignCalls.calls.inspect, 0);
  assert.equal(foreignCalls.calls.docker.length, 0);
  assert.equal(foreignCalls.calls.posts.length, 0);

  const mismatched = await createFixture(t);
  const apiPath = join(mismatched.state, 'management.json');
  const current = JSON.parse(await readFile(apiPath, 'utf8'));
  await writePrivate(apiPath, { ...current, jwtSecret: '8'.repeat(64) }, 1000, 1000);
  const keyCalls = dependencies(mismatched, async () => responseComplete());
  await assert.rejects(authSetup(mismatched.state, {}, keyCalls.deps));
  assert.equal(keyCalls.calls.ownership, 0);
  assert.equal(keyCalls.calls.inspect, 0);
  assert.equal(keyCalls.calls.docker.length, 0);
  assert.equal(keyCalls.calls.posts.length, 0);
});
