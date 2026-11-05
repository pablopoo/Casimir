import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
test('failed candidate during crash recovery restores verified previous service', async () => {
  const s = JSON.parse(readFileSync('/results/execution-recovery.json', 'utf8'));
  assert.ok(s.prior);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    let op;
    for (let n = 0; n < 120; n++) {
      op = (
        await db.query('SELECT * FROM casimir.execution_operations WHERE id=$1', [s.operationId])
      ).rows[0];
      if (['failed', 'succeeded', 'recovery_required'].includes(op.phase)) break;
      await delay(500);
    }
    assert.equal(op.phase, 'failed', JSON.stringify(op));
    assert.equal(op.outcome, 'restored');
    assert.equal(
      (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [s.projectId]))
        .rows[0].active_deployment_id,
      s.prior,
    );
    assert.equal(
      (await (await fetch('http://app-ingress:8080/version')).json()).deploymentId,
      s.prior,
    );
    assert.equal(
      (await (await fetch('http://app-ingress:8080/records/persisted')).json()).value,
      'keep-me',
    );
  } finally {
    await db.end();
  }
});
