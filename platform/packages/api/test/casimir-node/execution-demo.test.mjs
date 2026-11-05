import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
test('demo binds storage, preserves records, and denies readonly preflight writes', async () => {
  assert.ok(existsSync('casimir/demo/server.mjs'), 'fixed SQLite demo must exist');
  const dir = mkdtempSync('/tmp/casimir-demo-test-');
  const env = {
    ...process.env,
    CASIMIR_DATA_DIR: dir,
    CASIMIR_PROJECT_ID: 'proj_abcdefghijkl',
    CASIMIR_DEPLOYMENT_ID: 'dpl_abcdefghijkl',
    CASIMIR_DEMO_VERSION: 'v1',
    PORT: '4398',
  };
  delete env.NODE_TEST_CONTEXT;
  const init = (extra) =>
    spawnSync(process.execPath, ['casimir/demo/init-data.mjs'], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  let child;
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  };
  const start = async (extra) => {
    child = spawn(process.execPath, ['casimir/demo/server.mjs'], {
      env: { ...env, ...extra },
      stdio: 'ignore',
    });
    for (let n = 0; n < 50; n++) {
      try {
        const r = await fetch('http://127.0.0.1:4398/health');
        if (r.ok) return;
      } catch {}
      await delay(50);
    }
    assert.fail('demo not ready');
  };
  try {
    assert.equal(init().status, 0);
    await start({ CASIMIR_MODE: 'writable' });
    const write = (body) =>
      fetch('http://127.0.0.1:4398/records', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await write({ id: 'one', value: 'keep-me' })).status, 201);
    assert.equal((await write({ id: 'one', value: 'keep-me' })).status, 200);
    assert.equal((await write({ id: 'one', value: 'different' })).status, 409);
    const unicode = { id: 'café🌌', value: 'mañana🚀' };
    const bytes = Buffer.from(JSON.stringify(unicode));
    const split = bytes.indexOf(Buffer.from('🌌')) + 2;
    const chunked = await new Promise((resolve, reject) => {
      const req = request('http://127.0.0.1:4398/records', { method: 'POST' }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
        );
      });
      req.on('error', reject);
      req.write(bytes.subarray(0, split));
      setTimeout(() => req.end(bytes.subarray(split)), 100);
    });
    assert.equal(chunked.status, 201);
    assert.deepEqual(chunked.body, unicode);
    assert.equal((await write(unicode)).status, 200);
    assert.deepEqual(
      await (await fetch('http://127.0.0.1:4398/records/' + encodeURIComponent(unicode.id))).json(),
      unicode,
    );
    await stop();
    await start({ CASIMIR_MODE: 'read-only', CASIMIR_DEMO_VERSION: 'v2' });
    assert.equal((await write({ id: 'two', value: 'no' })).status, 403);
    assert.equal(
      (await (await fetch('http://127.0.0.1:4398/records/one')).json()).value,
      'keep-me',
    );
    await stop();
    assert.equal(init({ CASIMIR_PROJECT_ID: 'proj_mnopqrstuvwx' }).status, 1);
    assert.equal(init().status, 0);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
