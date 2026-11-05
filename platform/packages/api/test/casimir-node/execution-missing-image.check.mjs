import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const before = await (await fetch('http://app-ingress:8080/version')).json();
const d = await call('/projects/' + s.projectId + '/deployments', {});
assert.equal(d.status, 201);
const admitted = await call(
  '/projects/' + s.projectId + '/deployments/' + d.body.id + '/execute',
  { imageAlias: 'demo-broken' },
  'missing-image-' + d.body.id,
);
assert.equal(admitted.status, 202);
let op;
for (let n = 0; n < 60; n++) {
  op = (await call('/projects/' + s.projectId + '/operations/' + admitted.body.operationId)).body;
  if (['failed', 'succeeded', 'recovery_required'].includes(op.phase)) break;
  await delay(500);
}
assert.equal(op.phase, 'failed', JSON.stringify(op));
assert.equal(op.outcome, 'rejected');
assert.equal(op.activeDeploymentId, before.deploymentId);
assert.equal(
  (await (await fetch('http://app-ingress:8080/version')).json()).deploymentId,
  before.deploymentId,
);
console.log('Missing exact local image failed without pulling or changing service');
