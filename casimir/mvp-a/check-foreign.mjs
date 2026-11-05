import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { Client } = createRequire(
  new URL('../../platform/packages/api/package.json', import.meta.url),
)('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const app = 'http://casimir-mvp-a-app-ingress:8080';
try {
  const current = await fetch(app + '/');
  assert.equal(current.status, 200);
  const deployment = current.headers.get('x-casimir-deployment');
  await writeFile('.local/mvp-a/foreign-before.json', JSON.stringify({ deployment }));
  const result = await new Promise((resolve, reject) => {
    let text = '';
    const child = spawn(process.execPath, ['casimir/mvp-a/check-cli.mjs', 'update'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => (text += chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, text }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.text, /casimir_recovery_required/);
  const retry = JSON.parse(
    await readFile('.local/mvp-a/consumer/.void/casimir.retry.json', 'utf8'),
  );
  assert.equal(retry.finished, false);
  const op = (
    await db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [
      retry.receipt.operationId,
    ])
  ).rows[0];
  assert.equal(op.phase, 'recovery_required');
  assert.equal(op.exposure_started, null);
  assert.equal(op.snapshot_fingerprint, null);
  assert.equal(
    (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [op.project_id]))
      .rows[0].active_deployment_id,
    deployment,
  );
  assert.equal((await fetch(app + '/')).status, 503);
  assert.equal(
    Object.values(op.previous_target.jobs).filter((job) => job.action === 'restore').length,
    0,
  );
  console.log(
    JSON.stringify({
      gate: 'foreign-writer',
      operationId: op.id,
      phase: op.phase,
      previousDeployment: deployment,
      gateClosed: true,
      noRestore: true,
    }),
  );
} finally {
  await db.end();
}
