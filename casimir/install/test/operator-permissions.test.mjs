import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('install receives profile write/chmod caps while backup and status stay capless', async t => {
  const root = await mkdtemp(join(tmpdir(), 'casimir operator permissions '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const images = join(root, 'images');
  const configDir = join(root, 'config');
  await Promise.all([mkdir(bin), mkdir(images), mkdir(configDir)]);

  const wrapper = join(root, 'casimir');
  await copyFile(new URL('../casimir', import.meta.url), wrapper);
  await chmod(wrapper, 0o755);

  const imageArchive = 'synthetic lifecycle archive';
  const archiveHash = createHash('sha256').update(imageArchive).digest('hex');
  const imageId = `sha256:${'a'.repeat(64)}`;
  await writeFile(join(images, 'lifecycle.tar.gz'), imageArchive);
  await writeFile(join(root, 'bootstrap.txt'), `${archiveHash}\n${imageId}\n`);
  const config = join(configDir, 'operator.json');
  await writeFile(config, '{}');
  const key = join(root, 'backup.key');
  const backup = join(root, 'backup.enc');
  const backupOutputDir = join(root, 'output');
  await writeFile(key, 'synthetic backup key');
  await writeFile(backup, 'synthetic encrypted backup');
  await mkdir(backupOutputDir);

  const calls = join(root, 'docker-calls.log');
  const docker = join(bin, 'docker');
  await writeFile(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = image ] && [ "$2" = inspect ]; then printf "%s\\n" "$FAKE_IMAGE_ID"; fi\n');
  await chmod(docker, 0o755);
  const id = join(bin, 'id');
  await writeFile(id, '#!/bin/sh\n[ "$1" = -u ] || exit 2\nprintf "0\\n"\n');
  await chmod(id, 0o755);

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: calls,
    FAKE_IMAGE_ID: imageId,
  };
  const installState = join(root, 'state-install');
  const install = spawnSync(wrapper, ['install', '--state', installState, '--config', config], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || String(install.error));
  const backupRun = spawnSync(wrapper, ['backup', '--state', installState, '--output', join(backupOutputDir, 'backup.enc'), '--key-file', key], { env, encoding: 'utf8' });
  assert.equal(backupRun.status, 0, backupRun.stderr || String(backupRun.error));
  const status = spawnSync(wrapper, ['status', '--state', installState], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr || String(status.error));

  const runCalls = (await readFile(calls, 'utf8')).trim().split('\n').filter(line => line.startsWith('run '));
  assert.equal(runCalls.length, 6);
  const privilegedRuns = [runCalls[1]];
  for (const command of privilegedRuns) {
    assert.match(command, /--cap-drop ALL/);
    assert.match(command, /--read-only/);
    assert.match(command, /--user 0:0/);
    assert.deepEqual(command.match(/--cap-add \S+/g), ['--cap-add CHOWN', '--cap-add DAC_OVERRIDE', '--cap-add FOWNER']);
    assert.match(command, /src=\/var\/run\/docker\.sock,dst=\/var\/run\/docker\.sock/);
  }
  assert.match(runCalls[1], /--network host/);
  assert.match(runCalls[3], /--network none/);
  assert.match(runCalls[5], /--network none/);
  for (const command of [runCalls[0], runCalls[2], runCalls[3], runCalls[4], runCalls[5]]) {
    assert.doesNotMatch(command, /--cap-add/);
  }
  assert.match(runCalls[3], /node \/src\/casimir\/install\/cli\.mjs backup/);
  assert.match(runCalls[5], /node \/src\/casimir\/install\/cli\.mjs status/);
});
