import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const call = async (path, body, key) => {
  const r = await fetch('http://api:4281' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + process.env.CASIMIR_TOKEN,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
};
try {
  if (process.argv[2] === 'admit') {
    const s = JSON.parse(readFileSync('/results/execution-flow.json', 'utf8'));
    const before = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [s.projectId])
    ).rows[0].active_deployment_id;
    const d = await call('/projects/' + s.projectId + '/deployments', {});
    assert.equal(d.status, 201);
    const key = 'foreign-' + d.body.id,
      r = await call(
        '/projects/' + s.projectId + '/deployments/' + d.body.id + '/execute',
        { imageAlias: 'demo-v1' },
        key,
      );
    assert.equal(r.status, 202);
    assert.match(r.body.operationId, /^cex_[a-z0-9]{12}$/);
    writeFileSync(
      '/results/execution-foreign.json',
      JSON.stringify({
        projectId: s.projectId,
        deploymentId: d.body.id,
        operationId: r.body.operationId,
        before,
        key,
      }),
    );
    console.log('casimir-execution-poc-app-' + r.body.operationId);
  } else {
    const s = JSON.parse(readFileSync('/results/execution-foreign.json', 'utf8'));
    if (process.argv[2] === 'verify') {
      let op;
      for (let n = 0; n < 60; n++) {
        op = (
          await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [s.operationId])
        ).rows[0];
        if (op.phase === 'recovery_required') break;
        await delay(500);
      }
      assert.equal(op.phase, 'recovery_required');
      assert.equal(op.outcome, null);
      assert.equal(op.candidate_id, null);
      assert.equal(
        (await (await fetch('http://app-ingress:8080/version')).json()).deploymentId,
        s.before,
      );
      const retry = await call(
        '/projects/' + s.projectId + '/deployments/' + s.deploymentId + '/execute',
        { imageAlias: 'demo-v1' },
        s.key,
      );
      assert.equal(retry.status, 202);
      assert.equal(retry.body.operationId, s.operationId);
      assert.equal(retry.body.phase, 'recovery_required');
      console.log(
        'Foreign same-name resource rejected without adoption; previous service preserved',
      );
    } else if (process.argv[2] === 'repair') {
      const r = await db.query(
        "UPDATE casimir.execution_operations SET phase='preflighting',error='explicit removal of owned foreign-label fault',updated_at=now() WHERE id=$1 AND phase='recovery_required' AND candidate_id IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=$2 AND active_deployment_id=$3)",
        [s.operationId, s.projectId, s.before],
      );
      assert.equal(r.rowCount, 1);
      console.log('Rearmed only the exact synthetic foreign-label fault');
    } else if (process.argv[2] === 'recovered') {
      let op;
      for (let n = 0; n < 100; n++) {
        op = (
          await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [s.operationId])
        ).rows[0];
        if (['succeeded', 'failed', 'recovery_required'].includes(op.phase)) break;
        await delay(500);
      }
      assert.equal(op.phase, 'succeeded', JSON.stringify(op));
      assert.equal(op.outcome, 'activated');
      console.log('Guarded recovery completed after exact fixture removal');
    } else throw Error('invalid stage');
  }
} finally {
  await db.end();
}
