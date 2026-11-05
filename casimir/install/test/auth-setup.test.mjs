import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  parseAuthSetupArguments,
  prepareCasimirAuthSetupInput,
  readAuthSetupInputFile,
} from '../../dist/authSetup.mjs';

const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};

async function startSyntheticApi(t, { controlOrigin, appOrigin, enabled, setupStateB64 }) {
  const state = await mkdtemp(join(tmpdir(), 'casimir-auth-activation-'));
  const portServer = await import('node:net').then(({ createServer }) => createServer());
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolveClose, reject) =>
    portServer.close((error) => (error ? reject(error) : resolveClose())),
  );

  const installationId = 'a'.repeat(32);
  const configPath = join(state, 'management.json');
  const profilePath = join(state, 'profile.json');
  const management = {
    format: 1,
    installationId,
    ownershipNonce: 'b'.repeat(48),
    jwtSecret: 'c'.repeat(64),
    authSetupToken: 'd'.repeat(64),
    projectSecretKeysJson: JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') }),
    projectSecretActiveKeyVersion: '1',
    operatorId: 'user_abcdefghijkl',
    projectId: 'proj_abcdefghijkl',
  };
  await writeFile(configPath, JSON.stringify(management), { mode: 0o600 });
  await writeFile(
    profilePath,
    JSON.stringify({
      runtime,
      artifactRoot: join(state, 'artifacts'),
      installationId,
      origins: { control: controlOrigin, app: appOrigin },
    }),
    { mode: 0o600 },
  );
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    CASIMIR_TOKEN: 'synthetic-cli-token',
    CASIMIR_OPERATOR_ID: management.operatorId,
    PORT: String(port),
    CASIMIR_MVP_PROFILE: profilePath,
    CASIMIR_MANAGEMENT_CONFIG: configPath,
    ...(enabled === 'true' && setupStateB64 !== null
      ? {
          CASIMIR_AUTH_SETUP_STATE_B64:
            setupStateB64 ?? Buffer.from(state).toString('base64'),
        }
      : {}),
    ...(enabled === undefined ? {} : { CASIMIR_MANAGEMENT_ENABLED: enabled }),
  };
  const entry = resolve('casimir/dist/main.mjs');
  const child = spawn(process.execPath, [entry], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      let timer;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolveStop) => {
          timer = setTimeout(() => resolveStop(false), 1500);
        }),
      ]);
      clearTimeout(timer);
      if (!stopped) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(state, { recursive: true, force: true });
  });

  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(value);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), 3000);
    child.stdout.on('data', () => {
      if (output.includes('Casimir control listening')) finish({ kind: 'listening' });
    });
    child.on('exit', (code, signal) => finish({ kind: 'exit', code, signal }));
  });
  return { outcome, output, port, controlOrigin };
}

async function getAdminClient(result) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: result.port,
        method: 'GET',
        path: '/admin/client.js',
        headers: { Host: new URL(result.controlOrigin).host },
        timeout: 1500,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    request.end();
  });
}

test('an unmarked same-host TLS install remains CLI-only after publishing management files', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://control.example.test:4486',
  });
  assert.equal(
    result.outcome.kind,
    'listening',
    `legacy same-host TLS install should remain CLI-only; startup outcome=${JSON.stringify(result.outcome)}; output=${result.output}`,
  );
  assert.equal((await getAdminClient(result)).status, 401, 'unmarked CLI-only profile must not serve management assets');
});

test('unmarked distinct-host TLS config does not activate the management routes', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
  });
  assert.equal(
    result.outcome.kind,
    'listening',
    `distinct-host fixture should start; outcome=${JSON.stringify(result.outcome)}; output=${result.output}`,
  );
  assert.equal((await getAdminClient(result)).status, 401, 'management config presence must not activate routes');
});

test('an explicit false marker keeps the original distinct-host profile CLI-only', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
    enabled: 'false',
  });
  assert.equal(result.outcome.kind, 'listening', `explicit false should start CLI-only: ${result.output}`);
  assert.equal((await getAdminClient(result)).status, 401);
});

test('explicit management activation serves the original admin asset on distinct HTTPS hosts', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
    enabled: 'true',
  });
  assert.equal(result.outcome.kind, 'listening', `explicit activation should start: ${result.output}`);
  const response = await getAdminClient(result);
  assert.equal(response.status, 200);
  assert.ok(response.body.length > 1000, 'served body should be the built original admin client');
});

test('explicit management activation rejects equal canonical control and app hostnames', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://control.example.test:4486',
    enabled: 'true',
  });
  assert.equal(result.outcome.kind, 'exit', `unsafe explicit activation should fail before listening: ${result.output}`);
  assert.match(result.output, /distinct control and app hostnames/);
});

test('explicit management activation rejects an HTTP control origin clearly', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'http://control.example.test:4485',
    appOrigin: 'http://app.example.test:4486',
    enabled: 'true',
  });
  assert.equal(result.outcome.kind, 'exit', `unsafe explicit activation should fail before listening: ${result.output}`);
  assert.match(result.output, /requires an HTTPS control origin/);
});

test('explicit management activation requires its canonical persisted auth-setup state path', async (t) => {
  const missing = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
    enabled: 'true',
    setupStateB64: null,
  });
  assert.equal(missing.outcome.kind, 'exit');
  assert.match(missing.output, /requires its auth setup state/);

  const relative = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
    enabled: 'true',
    setupStateB64: Buffer.from('relative/path').toString('base64'),
  });
  assert.equal(relative.outcome.kind, 'exit');
  assert.match(relative.output, /auth setup state is invalid/);
});

test('an unmarked HTTP install remains CLI-only', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'http://control.example.test:4485',
    appOrigin: 'http://app.example.test:4486',
  });
  assert.equal(result.outcome.kind, 'listening', `legacy HTTP profile should start: ${result.output}`);
  assert.equal((await getAdminClient(result)).status, 401);
});

test('an invalid management activation marker fails closed', async (t) => {
  const result = await startSyntheticApi(t, {
    controlOrigin: 'https://control.example.test:4485',
    appOrigin: 'https://app.example.test:4486',
    enabled: 'yes',
  });
  assert.equal(result.outcome.kind, 'exit', `invalid activation marker should fail before listening: ${result.output}`);
  assert.match(result.output, /CASIMIR_MANAGEMENT_ENABLED must be true or false/);
});

test('the shipped installer CLI routes auth-setup through its argument validator', () => {
  const result = spawnSync(
    process.execPath,
    [resolve('casimir/install/cli.mjs'), 'auth-setup', '--state'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Usage: casimir auth-setup/);
  assert.doesNotMatch(result.stderr, /unsupported_lifecycle_command/);
});

test('auth-setup accepts a complete initial input or a checkpoint-only resume', () => {
  const state = '/private/casimir-state';
  const initial = parseAuthSetupArguments([
    '--state', state,
    '--auth-config', '/private/auth.json',
    '--auth-secrets', '/private/secrets.json',
    '--identity-policy', '/private/identity.json',
  ]);
  assert.deepEqual(initial, {
    state,
    authConfigPath: '/private/auth.json',
    authSecretsPath: '/private/secrets.json',
    identityPolicyPath: '/private/identity.json',
  });
  assert.deepEqual(parseAuthSetupArguments(['--state', state]), { state });
});

test('auth-setup argument validation rejects partial, duplicate, relative and unknown options', () => {
  for (const args of [
    [],
    ['--state', 'relative'],
    ['--state', '/private/state', '--auth-config', '/private/auth.json'],
    ['--state', '/private/state', '--identity-policy', '/private/policy.json'],
    ['--state', '/private/state', '--state', '/private/other'],
    ['--state', '/private/state', '--unexpected', 'value'],
  ]) {
    assert.throws(() => parseAuthSetupArguments(args), /auth_setup_usage/);
  }
});

test('auth setup input files must be canonical private regular files outside state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-auth-input-'));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const config = join(root, 'auth.json');
  await writeFile(config, '{"connections":[]}', { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await readAuthSetupInputFile(config, state, 1024), '{"connections":[]}');
  await assert.rejects(readAuthSetupInputFile(join(state, 'auth.json'), state, 1024), /auth_setup_input_path/);
  await assert.rejects(readAuthSetupInputFile('relative.json', state, 1024), /auth_setup_input_path/);

  const linked = join(root, 'linked.json');
  await symlink(config, linked);
  await assert.rejects(readAuthSetupInputFile(linked, state, 1024), /auth_setup_input_permissions/);

  const publicFile = join(root, 'public.json');
  await writeFile(publicFile, '{}', { mode: 0o644 });
  await assert.rejects(readAuthSetupInputFile(publicFile, state, 1024), /auth_setup_input_permissions/);

  const oversized = join(root, 'oversized.json');
  await writeFile(oversized, 'é'.repeat(513), { mode: 0o600 });
  await assert.rejects(readAuthSetupInputFile(oversized, state, 1024), /auth_setup_input_size/);
});

test('Casimir auth input reuses Void preparation and rejects unsupported access features', () => {
  const authentication = {
    administratorConnectionId: 'company',
    connections: [{
      clientSecretEnv: 'OIDC_SECRET',
      configuration: {
        id: 'company', kind: 'oidc', label: 'Company', clientId: 'client-id',
        issuer: 'https://idp.example.com', allowedDomains: [], requiredGroups: [],
      },
    }],
  };
  const prepared = prepareCasimirAuthSetupInput({
    authentication,
    secrets: { OIDC_SECRET: 'synthetic-secret' },
  });
  assert.equal(JSON.parse(prepared.authenticationSetupJson).connections[0].configuration.id, 'company');
  assert.equal(prepared.authBootstrapCode.length, 64);

  assert.throws(
    () => prepareCasimirAuthSetupInput({ authentication: { ...authentication, protection: { teamDomain: 'team' } }, secrets: { OIDC_SECRET: 'synthetic-secret' } }),
    /auth_setup_protection_unsupported/,
  );
  assert.throws(
    () => prepareCasimirAuthSetupInput({ authentication: { ...authentication, cloudflareAccess: {} }, secrets: { OIDC_SECRET: 'synthetic-secret' } }),
    /auth_setup_protection_unsupported/,
  );
  assert.throws(
    () => prepareCasimirAuthSetupInput({
      authentication: {
        ...authentication,
        connections: [{ ...authentication.connections[0], configuration: { ...authentication.connections[0].configuration, kind: 'cloudflare-access' } }],
      },
      secrets: { OIDC_SECRET: 'synthetic-secret' },
    }),
    /auth_setup_provider_unsupported/,
  );
  assert.throws(
    () => prepareCasimirAuthSetupInput({ authentication, secrets: { OIDC_SECRET: 'synthetic-secret', UNUSED: 'synthetic' } }),
    /unused entries/,
  );
});

test('the public auth-setup wrapper runs a root-owned host-network maintenance container with only selected private mounts', async (t) => {
  const scratch = process.env.CASIMIR_TEST_EXEC_TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, 'casimir auth wrapper '));
  const state = join(root, 'state');
  const authConfig = join(root, 'auth.json');
  const authSecrets = join(root, 'secrets.json');
  const config = join(root, 'config');
  const bin = join(root, 'bin');
  const imageId = `sha256:${'a'.repeat(64)}`;
  const archive = 'synthetic lifecycle archive';
  const archiveHash = createHash('sha256').update(archive).digest('hex');
  const calls = join(root, 'docker-calls');
  await Promise.all([
    mkdir(state, { mode: 0o700 }),
    mkdir(join(config, 'images'), { recursive: true }),
    mkdir(bin),
  ]);
  await Promise.all([
    writeFile(authConfig, '{"synthetic":true}', { mode: 0o600 }),
    writeFile(authSecrets, '{"OIDC_SECRET":"synthetic"}', { mode: 0o600 }),
    writeFile(join(config, 'images/lifecycle.tar.gz'), archive),
    writeFile(join(config, 'bootstrap.txt'), `${archiveHash}\n${imageId}\n`),
  ]);
  await copyFile(new URL('../casimir', import.meta.url), join(config, 'casimir'));
  await chmod(join(config, 'casimir'), 0o755);
  assert.equal((await stat(join(config, 'casimir'))).mode & 0o777, 0o755);
  await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "0\\n"\n');
  await chmod(join(bin, 'id'), 0o755);
  await writeFile(
    join(bin, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = image ]; then printf "%s\\n" "$IMAGE_ID"; fi\n',
  );
  await chmod(join(bin, 'docker'), 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync(
    '/bin/sh',
    [join(config, 'casimir'), 'auth-setup', '--state', state, '--auth-config', authConfig, '--auth-secrets', authSecrets],
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CALL_LOG: calls,
        IMAGE_ID: imageId,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(
    result.status,
    0,
    JSON.stringify({
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  const lines = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^image inspect /);
  assert.match(lines[1], /^run .*--network none.*bundle\.mjs/);
  assert.match(lines[2], /^run .*--network host .*--user 0:0.*--cap-drop ALL.*--cap-add CHOWN.*--cap-add DAC_OVERRIDE.*--cap-add FOWNER/);
  assert.ok(lines[2].includes(`type=bind,src=${state},dst=${state}`));
  assert.ok(lines[2].includes(`type=bind,src=${authConfig},dst=${authConfig},readonly`));
  assert.ok(lines[2].includes(`type=bind,src=${authSecrets},dst=${authSecrets},readonly`));
  assert.ok(lines[2].includes('node /src/casimir/install/cli.mjs auth-setup'));
  assert.doesNotMatch(lines[2], /--env(?:=| )/);
});
