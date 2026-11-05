import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const s = JSON.parse(readFileSync('/results/execution-recovery.json', 'utf8'));
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
  if (process.argv[2] === 'inject') {
    const op = (
      await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [s.operationId])
    ).rows[0];
    assert.equal(op.phase, 'verifying');
    const d = await call('/projects/' + s.projectId + '/deployments', {});
    assert.equal(d.status, 201);
    const prior = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [s.projectId])
    ).rows[0].active_deployment_id;
    assert.equal(prior, op.previous_target?.deploymentId ?? null);
    const changed = await db.query(
      'UPDATE projects SET active_deployment_id=$1 WHERE id=$2 AND active_deployment_id IS NOT DISTINCT FROM $3',
      [d.body.id, s.projectId, prior],
    );
    assert.equal(changed.rowCount, 1);
    writeFileSync(
      '/results/execution-mismatch.json',
      JSON.stringify({ ...s, prior, injected: d.body.id }),
    );
    console.log('Injected independent pointer change into owned synthetic fixture');
  } else if (process.argv[2] === 'verify') {
    const fault = JSON.parse(readFileSync('/results/execution-mismatch.json', 'utf8'));
    let op;
    for (let n = 0; n < 60; n++) {
      op = (
        await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [
          fault.operationId,
        ])
      ).rows[0];
      if (op.phase === 'recovery_required') break;
      await delay(500);
    }
    assert.equal(op.phase, 'recovery_required');
    assert.equal(op.outcome, null);
    assert.equal(
      (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [fault.projectId]))
        .rows[0].active_deployment_id,
      fault.injected,
    );
    assert.equal(
      (await (await fetch('http://app-ingress:8080/version')).json()).deploymentId,
      fault.deploymentId,
      'unexpected SQL pointer must not overwrite ingress',
    );
    const next = await call('/projects/' + fault.projectId + '/deployments', {});
    assert.equal(next.status, 201);
    assert.equal(
      (
        await call(
          '/projects/' + fault.projectId + '/deployments/' + next.body.id + '/execute',
          { imageAlias: 'demo-v1' },
          'blocked-' + next.body.id,
        )
      ).status,
      409,
    );
    const retry = await call(
      '/projects/' + fault.projectId + '/deployments/' + fault.deploymentId + '/execute',
      { imageAlias: 'demo-v1' },
      'recovery-' + fault.deploymentId,
    );
    assert.equal(retry.status, 202);
    assert.equal(retry.body.operationId, fault.operationId);
    assert.equal(retry.body.phase, 'recovery_required');
    console.log('Conflicting pointer preserved; operation blocked and new admission409');
  } else if (process.argv[2] === 'repair') {
    const fault = JSON.parse(readFileSync('/results/execution-mismatch.json', 'utf8'));
    await db.query('BEGIN');
    const restored = await db.query(
      'UPDATE projects SET active_deployment_id=$1 WHERE id=$2 AND active_deployment_id=$3',
      [fault.prior, fault.projectId, fault.injected],
    );
    assert.equal(restored.rowCount, 1);
    const rearmed = await db.query(
      "UPDATE casimir.execution_operations SET phase='verifying',error='explicit repair of owned pointer fault',updated_at=now() WHERE id=$1 AND phase='recovery_required' AND candidate_id=$2",
      [fault.operationId, fault.candidateId],
    );
    assert.equal(rearmed.rowCount, 1);
    await db.query('COMMIT');
    console.log('Repaired only exact injected pointer fault; guarded recovery required');
  } else throw Error('unknown fixture stage');
} finally {
  await db.end();
}
