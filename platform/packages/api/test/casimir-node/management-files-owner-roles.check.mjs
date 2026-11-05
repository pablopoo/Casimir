import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  publishCasimirManagementConfig,
  replaceCasimirManagementConfig,
  prepareCasimirManagementOwner,
  readCasimirManagementConfig,
  readCasimirManagementOwner,
} from '../../src/casimir/management/management-files.ts';
import { atomicPrivateJson, initializeInstallation, readPrivate } from '../../src/casimir/lifecycle/identity.ts';

const fixtureRoot = '/work/owner-role-fixture';
const installConfig = {
  format: 1,
  mode: 'loopback',
  controlOrigin: 'http://127.0.0.1:4485',
  appOrigin: 'http://127.0.0.1:4486',
  bindAddress: '127.0.0.1',
  controlPort: 4485,
  appPort: 4486,
};

async function ownerProcess() {
  assert.equal(process.getuid?.(), 0, 'owner-role setup must run as UID 0');
  await mkdir(fixtureRoot, { mode: 0o755 });
  const state = join(fixtureRoot, 'state');
  await initializeInstallation(
    state,
    installConfig,
    { version: 'c1.1', hash: 'c'.repeat(64) },
    async () => ({ operatorId: 'user_aaaaaaaaaaaa', projectId: 'proj_bbbbbbbbbbbb' }),
  );
  const identity = await readPrivate(join(state, 'identity.json'));
  const owner = await prepareCasimirManagementOwner(state, identity);
  const configPath = join(state, 'management.json');

  // Model a process interruption after the atomic root-owned write and before chown.
  await atomicPrivateJson(configPath, owner);
  const pendingBytes = await readFile(configPath);
  const pendingMetadata = await stat(configPath);
  assert.equal(pendingMetadata.uid, 0);
  assert.equal(pendingMetadata.mode & 0o777, 0o600);
  await publishCasimirManagementConfig(state, owner);
  const repairedBytes = await readFile(configPath);
  const repairedMetadata = await stat(configPath);
  assert.deepEqual(repairedBytes, pendingBytes);
  assert.equal(repairedMetadata.uid, 1000);
  assert.equal(repairedMetadata.gid, 1000);
  assert.equal(repairedMetadata.mode & 0o777, 0o600);

  const repairedHash = createHash('sha256').update(repairedBytes).digest('hex');
  await publishCasimirManagementConfig(state, owner);
  assert.equal(createHash('sha256').update(await readFile(configPath)).digest('hex'), repairedHash);
  const retryMetadata = await stat(configPath);
  assert.equal(retryMetadata.uid, 1000);
  assert.equal(retryMetadata.mode & 0o777, 0o600);

  const nextOwner = {
    ...owner,
    identityNetwork: {
      origins: [{ origin: 'https://idp.example.com', addresses: ['1.1.1.1'] }],
    },
  };
  const previousApiBytes = await readFile(configPath);
  await assert.rejects(
    replaceCasimirManagementConfig(state, nextOwner),
    /management_configuration_conflict/,
  );
  assert.deepEqual(await readFile(configPath), previousApiBytes);
  await atomicPrivateJson(join(state, 'management-owner.json'), nextOwner);
  await replaceCasimirManagementConfig(state, nextOwner);
  const targetApiBytes = await readFile(configPath);
  const targetApiMetadata = await stat(configPath);
  assert.notDeepEqual(targetApiBytes, previousApiBytes);
  assert.equal(targetApiMetadata.uid, 1000);
  assert.equal(targetApiMetadata.gid, 1000);
  assert.equal(targetApiMetadata.mode & 0o777, 0o600);
  assert.equal((await readCasimirManagementConfig(configPath)).identityNetwork.origins[0].origin, 'https://idp.example.com');

  const alteredState = join(fixtureRoot, 'altered');
  await mkdir(alteredState, { mode: 0o700 });
  await chmod(alteredState, 0o700);
  await atomicPrivateJson(join(alteredState, 'management-owner.json'), owner);
  const alteredConfig = {
    ...owner,
    jwtSecret: `${owner.jwtSecret[0] === 'a' ? 'b' : 'a'}${owner.jwtSecret.slice(1)}`,
  };
  const alteredPath = join(alteredState, 'management.json');
  await atomicPrivateJson(alteredPath, alteredConfig);
  const alteredBytes = await readFile(alteredPath);
  const alteredMetadata = await stat(alteredPath);
  await assert.rejects(
    publishCasimirManagementConfig(alteredState, owner),
    /management_configuration_conflict/,
  );
  assert.deepEqual(await readFile(alteredPath), alteredBytes);
  const afterConflict = await stat(alteredPath);
  assert.equal(afterConflict.uid, alteredMetadata.uid);
  assert.equal(afterConflict.mode & 0o777, alteredMetadata.mode & 0o777);

  const apiDirectory = join(fixtureRoot, 'api');
  await mkdir(apiDirectory, { mode: 0o755 });
  await chmod(apiDirectory, 0o755);
  const apiPath = join(apiDirectory, 'management.json');
  await atomicPrivateJson(apiPath, owner);
  await chown(apiPath, 1000, 1000);

  process.stdout.write(JSON.stringify({
    status: 'root-phase-passed',
    pendingResumePreservedBytes: true,
    rootRetryPreservedBytes: true,
    atomicApiReplacementPreservedReaderOwner: true,
    alteredPendingRejectedUnchanged: true,
    apiFileUid: (await stat(apiPath)).uid,
    apiFileMode: (await stat(apiPath)).mode & 0o777,
    apiPath,
    ownerPath: join(state, 'management-owner.json'),
  }) + '\n');
}

async function apiReaderProcess(apiPath, ownerPath) {
  assert.equal(process.getuid?.(), 1000, 'API reader must run as UID 1000');
  const status = await readFile('/proc/self/status', 'utf8');
  const effectiveCapabilities = status.match(/^CapEff:\s*([0-9a-f]+)$/m)?.[1];
  assert.equal(effectiveCapabilities, '0000000000000000');
  const config = await readCasimirManagementConfig(apiPath);
  await assert.rejects(
    readCasimirManagementOwner(dirname(ownerPath)),
    (error) => error?.code === 'EACCES',
  );
  await assert.rejects(
    readFile(ownerPath),
    (error) => error?.code === 'EACCES',
  );
  assert.match(config.installationId, /^[a-f0-9]{32}$/);
  process.stdout.write(JSON.stringify({
    status: 'api-reader-passed',
    uid: process.getuid?.(),
    effectiveCapabilities,
    ownerRecordDenied: true,
  }) + '\n');
}

const [mode, apiPath, ownerPath] = process.argv.slice(2);
if (mode === '--root') {
  await ownerProcess();
} else if (mode === '--api-reader' && apiPath && ownerPath) {
  await apiReaderProcess(apiPath, ownerPath);
} else {
  throw new Error('Use --root as UID 0, then --api-reader as UID 1000.');
}
