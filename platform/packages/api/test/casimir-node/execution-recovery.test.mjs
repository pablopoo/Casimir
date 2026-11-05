import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
test('crash after route finishes the healthy unchanged candidate exactly once', async () => {
  assert.equal(typeof checks.reconcileOperation, 'function', 'startup reconciliation must exist');
  const s = JSON.parse(readFileSync('/results/execution-recovery.json', 'utf8'));
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    let op;
    for (let n = 0; n < 100; n++) {
      op = (
        await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [s.operationId])
      ).rows[0];
      if (['succeeded', 'failed', 'recovery_required'].includes(op.phase)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(op.phase, 'succeeded', JSON.stringify(op));
    assert.equal(op.outcome, 'activated');
    const pointer = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [s.projectId])
    ).rows[0].active_deployment_id;
    assert.equal(pointer, s.deploymentId);
    assert.equal(op.candidate_id, s.candidateId);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int n FROM casimir.execution_operations WHERE deployment_id=$1',
          [s.deploymentId],
        )
      ).rows[0].n,
      1,
    );
    const served = await (await fetch('http://app-ingress:8080/version')).json();
    assert.equal(served.deploymentId, s.deploymentId);
    assert.equal(
      (await (await fetch('http://app-ingress:8080/records/persisted')).json()).value,
      'keep-me',
    );
  } finally {
    await db.end();
  }
});
