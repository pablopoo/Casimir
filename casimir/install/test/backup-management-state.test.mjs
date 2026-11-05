import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backup } from '../backup.mjs';

test('backup rejects an invalid pending management checkpoint before requesting maintenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-backup-pending-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const installationId = 'a'.repeat(32);
  const identity = {
    installationId,
    token: 'b'.repeat(64),
    bundleVersion: 'c1.0',
    bundleHash: 'c'.repeat(64),
  };
  const receipt = {
    installationId,
    bundleVersion: 'c1.0',
    bundleHash: identity.bundleHash,
    operatorId: 'user_abcdefghijkl',
    projectId: 'proj_abcdefghijkl',
    phase: 'ready',
  };
  const owner = {
    format: 1,
    installationId,
    ownershipNonce: 'n'.repeat(48),
    jwtSecret: 'd'.repeat(64),
    authSetupToken: 'e'.repeat(64),
    projectSecretKeysJson: JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') }),
    projectSecretActiveKeyVersion: '1',
    operatorId: receipt.operatorId,
    projectId: receipt.projectId,
  };
  const apiEnv = [
    'CASIMIR_MANAGEMENT_CONFIG=/config/management.json',
    'CASIMIR_MANAGEMENT_ENABLED=true',
    `CASIMIR_AUTH_SETUP_STATE_B64=${Buffer.from(state).toString('base64')}`,
  ].join('\n') + '\n';
  for (const [name, value] of Object.entries({
    'identity.json': identity,
    'receipt.json': receipt,
    'management-owner.json': owner,
    'management.json': owner,
    'compose.json': { services: { operator: { image: 'sha256:' + '1'.repeat(64) } } },
  })) {
    await writeFile(join(state, name), JSON.stringify(value) + '\n', { mode: 0o600 });
  }
  await writeFile(join(state, 'api.env'), apiEnv, { mode: 0o600 });
  await writeFile(join(state, 'auth-setup-checkpoint.json'), '{"format":1}\n', { mode: 0o600 });
  const key = join(root, 'backup.key');
  await writeFile(key, Buffer.alloc(32, 1), { mode: 0o600 });
  const output = join(root, 'backup.csb');
  const dockerCommands = [];

  await assert.rejects(
    backup(state, output, key, {
      docker(args) {
        dockerCommands.push(args);
        if (args[0] === 'volume' || args[0] === 'container') {
          return JSON.stringify([{ Labels: { 'org.casimir.installation': installationId } }]);
        }
        assert.ok(args.includes('casimir/install/management-state-preflight.mjs'));
        assert.equal(args.at(-1), state, 'the trusted helper receives the canonical operational state path');
        return JSON.stringify({ validated: false, code: 'management_auth_setup_checkpoint_conflict' });
      },
    }),
    /management_auth_setup_checkpoint_conflict/,
  );
  const helper = dockerCommands.find((args) => args.includes('casimir/install/management-state-preflight.mjs'));
  assert.ok(helper, 'fixed validation helper ran before request-backup');
  assert.equal(dockerCommands.some((args) => args.includes('request-backup')), false);
  assert.equal(helper.includes('/var/run/docker.sock'), false);
  assert.equal(helper.includes('--network') && helper[helper.indexOf('--network') + 1] === 'none', true);
  assert.equal(helper.includes('--cap-add') && helper[helper.indexOf('--cap-add') + 1] === 'DAC_READ_SEARCH', true);
  assert.equal(JSON.parse(await readFile(join(state, 'receipt.json'), 'utf8')).phase, 'ready');
  await assert.rejects(readFile(join(state, 'maintenance.json')), { code: 'ENOENT' });
});
