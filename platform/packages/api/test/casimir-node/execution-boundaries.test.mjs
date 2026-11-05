import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
test('observed Docker profile has one writer and no API/app socket or published app port', async () => {
  const resources = JSON.parse(readFileSync('/results/execution-resources.json', 'utf8'));
  const api = resources.find((x) => x.role === 'api'),
    executor = resources.find((x) => x.role === 'executor');
  const apps = resources.filter((x) => x.role === 'app'),
    writers = apps.filter(
      (x) => x.running && x.mounts.some((m) => m.Destination === '/data' && m.RW),
    );
  assert.ok(api && executor);
  assert.equal(writers.length, 1);
  for (const c of [api, ...apps]) {
    assert.ok(c.user === 'node' || c.user === '1000:1000');
    assert.equal(c.readonly, true);
    assert.ok(c.capDrop.includes('ALL'));
    assert.ok(c.security.includes('no-new-privileges:true'));
    assert.ok(
      !c.mounts.some(
        (m) => m.Source === '/var/run/docker.sock' || m.Destination === '/var/run/docker.sock',
      ),
    );
    assert.equal(Object.keys(c.ports ?? {}).length, 0);
    assert.ok(c.memory > 0);
    assert.ok(c.cpus > 0);
    assert.ok(c.pids > 0);
  }
  assert.ok(executor.mounts.some((m) => m.Destination === '/var/run/docker.sock'));
  const state = JSON.parse(readFileSync('/results/execution-flow.json', 'utf8'));
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const active = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [state.projectId])
    ).rows[0].active_deployment_id;
    assert.equal(writers[0].deploymentId, active);
    const old = apps.find((c) => c.deploymentId === state.v1);
    assert.equal(old.running, false);
    assert.equal(
      (
        await db.query(
          'SELECT billing_user_id=initiated_by_user_id AS same FROM deployments WHERE id=$1',
          [state.v2],
        )
      ).rows[0].same,
      true,
    );
  } finally {
    await db.end();
  }
});
