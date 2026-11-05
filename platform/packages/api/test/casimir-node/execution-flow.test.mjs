import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as checks from '../../../../../casimir/dist/checks.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const base = 'http://api:4281',
  app = 'http://app-ingress:8080';
export async function call(path, body, key) {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.CASIMIR_TOKEN,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  });
  return { status: r.status, body: await r.json() };
}
export async function terminal(projectId, operationId) {
  for (let n = 0; n < 160; n++) {
    const r = await call('/projects/' + projectId + '/operations/' + operationId);
    if (['succeeded', 'failed', 'recovery_required'].includes(r.body.phase)) return r.body;
    await delay(500);
  }
  assert.fail('execution did not reach terminal/blocked phase');
}
export async function execute(projectId, alias, key) {
  const d = await call('/projects/' + projectId + '/deployments', {});
  assert.equal(d.status, 201);
  const r = await call(
    '/projects/' + projectId + '/deployments/' + d.body.id + '/execute',
    { imageAlias: alias },
    key + '-' + d.body.id,
  );
  assert.equal(r.status, 202);
  return { deployment: d.body, operation: r.body };
}
test('real v1/v2 preserves data and broken candidate preserves active v2', async () => {
  assert.equal(typeof checks.executeOperation, 'function', 'journal-driven executor must exist');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    let state;
    try {
      state = JSON.parse(readFileSync('/results/execution-flow.json', 'utf8'));
    } catch {}
    if (!state) {
      const p = await call('/projects', { slug: 'execution-demo' });
      assert.equal(p.status, 201);
      state = { projectId: p.body.id };
      writeFileSync('/results/execution-flow.json', JSON.stringify(state));
    }
    const v1 = await execute(state.projectId, 'demo-v1', 'flow-v1');
    const first = await terminal(state.projectId, v1.operation.operationId);
    assert.equal(first.phase, 'succeeded', JSON.stringify(first));
    assert.equal(first.outcome, 'activated');
    const served1 = await (await fetch(app + '/version')).json();
    assert.equal(served1.version, 'v1');
    assert.equal(served1.deploymentId, v1.deployment.id);
    const written = await fetch(app + '/records', {
      method: 'POST',
      body: JSON.stringify({ id: 'persisted', value: 'keep-me' }),
    });
    assert.ok([200, 201].includes(written.status));
    const v2 = await execute(state.projectId, 'demo-v2', 'flow-v2');
    const second = await terminal(state.projectId, v2.operation.operationId);
    assert.equal(second.phase, 'succeeded', JSON.stringify(second));
    const served = await (await fetch(app + '/version')).json();
    const readBack = await (await fetch(app + '/records/persisted')).json();
    const pointer = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [state.projectId])
    ).rows[0].active_deployment_id;
    assert.equal(served.version, 'v2');
    assert.equal(readBack.value, 'keep-me');
    assert.equal(pointer, served.deploymentId);
    assert.equal(second.lastObservedTarget.deploymentId, served.deploymentId);
    assert.equal(second.lastObservedTarget.imageId, second.requestedTarget.imageId);
    const broken = await execute(state.projectId, 'demo-broken', 'flow-broken');
    const failed = await terminal(state.projectId, broken.operation.operationId);
    assert.equal(failed.phase, 'failed', JSON.stringify(failed));
    assert.equal(failed.outcome, 'rejected');
    assert.equal((await (await fetch(app + '/version')).json()).deploymentId, served.deploymentId);
    assert.equal((await (await fetch(app + '/records/persisted')).json()).value, 'keep-me');
    state = { ...state, v1: v1.deployment.id, v2: v2.deployment.id, broken: broken.deployment.id };
    writeFileSync('/results/execution-flow.json', JSON.stringify(state));
  } finally {
    await db.end();
  }
});
