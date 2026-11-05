import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAuthenticationSetup } from '../../../packages/void/src/cli/platform-auth-input.ts';
import { authenticationSetupRequestHash } from '../../../packages/void/src/cli/platform-auth-input.ts';
import { managementKeyFingerprint } from '../../dist/managementCheckpoint.mjs';

const managementState = await import('../management-state.mjs').catch(() => ({}));

function fixture() {
  const installationId = 'a'.repeat(32);
  const operatorId = 'user_aaaaaaaaaaaa';
  const projectId = 'proj_bbbbbbbbbbbb';
  const owner = {
    format: 1,
    installationId,
    ownershipNonce: 'c'.repeat(32),
    jwtSecret: 'd'.repeat(64),
    authSetupToken: 'e'.repeat(64),
    projectSecretKeysJson: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
    projectSecretActiveKeyVersion: '1',
    operatorId,
    projectId,
  };
  return {
    identity: { installationId, token: 'f'.repeat(64) },
    receipt: { installationId, operatorId, projectId },
    owner,
  };
}

test('management capture verifier exists and recognizes only a complete validated owner/config pair', async (t) => {
  assert.equal(typeof managementState.inspectManagementStatePair, 'function', 'management capture verifier missing');
  if (typeof managementState.inspectManagementStatePair !== 'function') return;

  const root = await mkdtemp(join(tmpdir(), 'casimir-management-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  await writeFile(join(state, 'api.env'), 'PORT=3000\n', { mode: 0o600 });
  assert.equal(await managementState.inspectManagementStatePair(state, identity, receipt), null);
  await writeFile(join(state, 'api.env'), 'CASIMIR_MANAGEMENT_CONFIG=/config/management.json\n', { mode: 0o600 });
  await assert.rejects(managementState.inspectManagementStatePair(state, identity, receipt), /management_configuration_pair/);
  await writeFile(join(state, 'api.env'), 'PORT=3000\n', { mode: 0o600 });

  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt),
    /management_configuration_pair/,
  );

  await writeFile(join(state, 'management.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'api.env'), 'PORT=3000\nCASIMIR_MANAGEMENT_CONFIG=/config/management.json\n', { mode: 0o600 });
  assert.deepEqual(await managementState.inspectManagementStatePair(state, identity, receipt), {
    ownerPath: join(state, 'management-owner.json'),
    configPath: join(state, 'management.json'),
  });

  const altered = { ...owner, jwtSecret: '1'.repeat(64) };
  await writeFile(join(state, 'management.json'), JSON.stringify(altered) + '\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt),
    /management_configuration_conflict/,
  );
});

test('restore verifier accepts only a matching owner/config pair and API path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-management-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  await writeFile(join(state, 'api.env'), 'PORT=3000\n', { mode: 0o600 });

  assert.equal(
    await managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    false,
  );
  await writeFile(join(state, 'api.env'), 'PORT=3000\nCASIMIR_MANAGEMENT_CONFIG=/config/management.json\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    /restore_management_config_pair/,
  );

  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    /restore_management_config_pair/,
  );

  await writeFile(join(state, 'management.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  assert.equal(
    await managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    true,
  );

  const altered = { ...owner, jwtSecret: '1'.repeat(64) };
  await writeFile(join(state, 'management.json'), JSON.stringify(altered) + '\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    /restore_management_config_identity/,
  );
});

test('restore verifier rejects oversized management key files before JSON parsing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-management-restore-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  await writeFile(join(state, 'api.env'), 'CASIMIR_MANAGEMENT_CONFIG=/config/management.json\n', { mode: 0o600 });
  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'management.json'), ' '.repeat(65_537), { mode: 0o600 });
  await assert.rejects(
    managementState.inspectRestoredManagementStatePair(state, identity, receipt),
    /management_configuration_size/,
  );
});

test('capture verifier rejects a malformed pending auth checkpoint instead of silently omitting it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-management-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'management.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'api.env'), [
    'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
    'CASIMIR_MANAGEMENT_ENABLED=true',
    `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(state).toString('base64')}`,
  ].join('\n') + '\n', { mode: 0o600 });
  await writeFile(join(state, 'auth-setup-checkpoint.json'), JSON.stringify({ format: 1 }) + '\n', { mode: 0o600 });

  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt),
    /checkpoint/,
  );
});

test('capture and restore validate and retain a bound pending auth checkpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-management-checkpoint-valid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  const prepared = prepareAuthenticationSetup({
    administratorConnectionId: 'company',
    connections: [{
      clientSecret: 'synthetic-only-secret',
      configuration: {
        id: 'company', kind: 'oidc', label: 'Company', clientId: 'synthetic-client',
        issuer: 'https://idp.example.com', allowedDomains: [], requiredGroups: [],
      },
    }],
    admission: { mode: 'restricted' },
    protection: null,
  });
  const checkpoint = {
    format: 1,
    installationId: identity.installationId,
    keyFingerprint: managementKeyFingerprint(owner),
    authConfigHash: '1'.repeat(64),
    authSecretsHash: '2'.repeat(64),
    identityPolicyHash: null,
    identityNetwork: null,
    previousIdentityNetwork: null,
    authenticationSetupJson: prepared.authenticationSetupJson,
    authBootstrapCode: prepared.authBootstrapCode,
    requestHash: authenticationSetupRequestHash(prepared.authenticationSetupJson),
  };
  const operationalStatePath = '/srv/casimir/source state';
  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'management.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'api.env'), [
    'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
    'CASIMIR_MANAGEMENT_ENABLED=true',
    `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(operationalStatePath).toString('base64')}`,
  ].join('\n') + '\n', { mode: 0o600 });
  const checkpointPath = join(state, 'auth-setup-checkpoint.json');
  await writeFile(checkpointPath, JSON.stringify(checkpoint) + '\n', { mode: 0o600 });

  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt),
    /management_auth_setup_state_path/,
  );
  assert.deepEqual(await managementState.inspectManagementStatePair(state, identity, receipt, operationalStatePath), {
    ownerPath: join(state, 'management-owner.json'),
    configPath: join(state, 'management.json'),
    checkpointPath,
  });
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt, '/srv/casimir/other'),
    /management_auth_setup_state_path/,
  );
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt, '/srv/casimir/../other'),
    /management_auth_setup_state_path/,
  );
  const restored = await managementState.inspectRestoredManagementState(state, identity, receipt);
  assert.equal(restored.managementConfig, true);
  assert.equal(restored.managementEnabled, true);
  assert.equal(restored.authSetupStatePath, operationalStatePath);

  const targetPolicy = { origins: [{ origin: 'https://idp.example.com', addresses: ['10.10.1.8'] }] };
  await writeFile(join(state, 'management-owner.json'), JSON.stringify({ ...owner, identityNetwork: targetPolicy }) + '\n', { mode: 0o600 });
  await writeFile(checkpointPath, JSON.stringify({
    ...checkpoint,
    identityPolicyHash: '3'.repeat(64),
    identityNetwork: targetPolicy,
  }) + '\n', { mode: 0o600 });
  assert.ok(await managementState.inspectManagementStatePair(state, identity, receipt, operationalStatePath), 'checkpoint authorizes only the original owner-first partial policy update');

  await writeFile(checkpointPath, JSON.stringify({ ...checkpoint, installationId: '9'.repeat(32) }) + '\n', { mode: 0o600 });
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt, operationalStatePath),
    /management_auth_setup_checkpoint_conflict/,
  );
  await writeFile(checkpointPath, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(
    managementState.inspectManagementStatePair(state, identity, receipt, operationalStatePath),
    /management_auth_setup_checkpoint_invalid/,
  );
});

test('restored management activation is explicit and defaults to legacy CLI-only', async (t) => {
  assert.equal(typeof managementState.inspectRestoredManagementState, 'function', 'structured restore activation reader missing');
  if (typeof managementState.inspectRestoredManagementState !== 'function') return;
  const root = await mkdtemp(join(tmpdir(), 'casimir-management-restore-activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const { identity, receipt, owner } = fixture();
  await writeFile(join(state, 'management-owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'management.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
  await writeFile(join(state, 'api.env'), 'CASIMIR_MANAGEMENT_CONFIG=/config/management.json\n', { mode: 0o600 });

  const legacy = await managementState.inspectRestoredManagementState(state, identity, receipt);
  assert.equal(legacy.managementConfig, true);
  assert.equal(legacy.managementEnabled, false, 'pair presence must not activate identity egress');
  assert.equal(legacy.authSetupStatePath, null);

  const sourceState = '/srv/casimir/old state';
  await writeFile(join(state, 'api.env'), [
    'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
    'CASIMIR_MANAGEMENT_ENABLED=true',
    `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(sourceState).toString('base64')}`,
  ].join('\n') + '\n', { mode: 0o600 });
  const managed = await managementState.inspectRestoredManagementState(state, identity, receipt);
  assert.equal(managed.managementConfig, true);
  assert.equal(managed.managementEnabled, true);
  assert.equal(managed.authSetupStatePath, sourceState);
});

test('restore rewrites only the authenticated auth-setup state path for an isolated target', () => {
  assert.equal(typeof managementState.rewriteAuthSetupStatePath, 'function', 'restore state-path rewriter missing');
  if (typeof managementState.rewriteAuthSetupStatePath !== 'function') return;
  const sourceState = '/srv/casimir/source state';
  const targetState = '/restore/casimir/state';
  const input = [
    'PORT=3000',
    'CASIMIR_MANAGEMENT_ENABLED=true',
    `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(sourceState).toString('base64')}`,
  ].join('\n') + '\n';
  const output = managementState.rewriteAuthSetupStatePath(input, targetState);
  const lines = output.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['PORT=3000', 'CASIMIR_MANAGEMENT_ENABLED=true']);
  assert.equal(lines[2], `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(targetState).toString('base64')}`);
  assert.equal(Buffer.from(lines[2].split('=')[1], 'base64').toString('utf8'), targetState);
  const crlf = input.replaceAll('\n', '\r\n');
  assert.equal(
    managementState.rewriteAuthSetupStatePath(crlf, targetState),
    crlf.replace(`CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(sourceState).toString('base64')}`, `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(targetState).toString('base64')}`),
    'operational path rewrite preserves unrelated CRLF bytes exactly',
  );
});
