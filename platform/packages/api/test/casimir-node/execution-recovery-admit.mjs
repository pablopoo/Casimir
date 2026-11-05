import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const s = JSON.parse(readFileSync('/results/execution-flow.json', 'utf8'));
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
const d = await call('/projects/' + s.projectId + '/deployments', {});
assert.equal(d.status, 201);
const r = await call(
  '/projects/' + s.projectId + '/deployments/' + d.body.id + '/execute',
  { imageAlias: 'demo-v1' },
  'recovery-' + d.body.id,
);
assert.equal(r.status, 202);
let receipt;
for (let n = 0; n < 100; n++) {
  receipt = (await call('/projects/' + s.projectId + '/operations/' + r.body.operationId)).body;
  if (
    receipt.phase === 'verifying' &&
    (receipt.lastObservedTarget || process.env.CASIMIR_RECOVERY_JOB_CHECKPOINT)
  )
    break;
  await delay(500);
}
assert.equal(receipt.phase, 'verifying', JSON.stringify(receipt));
let candidateId = receipt.lastObservedTarget?.containerId;
if (process.env.CASIMIR_RECOVERY_JOB_CHECKPOINT) {
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const db = new (require('pg').Client)({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    candidateId = (
      await db.query('SELECT candidate_id FROM casimir.execution_operations WHERE id=$1', [
        r.body.operationId,
      ])
    ).rows[0].candidate_id;
  } finally {
    await db.end();
  }
}
assert.ok(candidateId);
writeFileSync(
  '/results/execution-recovery.json',
  JSON.stringify({
    projectId: s.projectId,
    deploymentId: d.body.id,
    operationId: r.body.operationId,
    candidateId,
    prior: receipt.activeDeploymentId,
  }),
);
console.log('Verified route checkpoint ready for trusted executor kill');
