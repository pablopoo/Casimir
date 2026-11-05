import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { Client } = createRequire(
  new URL('../../platform/packages/api/package.json', import.meta.url),
)('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const root = '.local/mvp-a/consumer',
  app = 'http://casimir-mvp-a-app-ingress:8080';
async function cli(failure = false) {
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
  if (failure) {
    assert.notEqual(result.code, 0);
    assert.match(result.text, /casimir_deployment_failed/);
  } else {
    assert.equal(result.code, 0, result.text);
  }
  const retry = JSON.parse(await readFile(root + '/.void/casimir.retry.json', 'utf8'));
  return (
    await db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [
      retry.receipt.operationId,
    ])
  ).rows[0];
}
try {
  if (process.argv[2] === 'setup') {
    const hook = await readFile('casimir/examples/notes/compatibility/check.js', 'utf8');
    await writeFile(
      root + '/compatibility/check.js',
      hook.replace(
        'export async function verifyCompatibility({ db, recordId }) {',
        'export async function verifyCompatibility({ db, recordId }) {\n await new Promise(resolve=>setTimeout(resolve,15000));',
      ),
    );
    assert.equal((await cli()).phase, 'succeeded');
    console.log('Retained bounded slow compatibility hook installed');
  } else {
    const before = await (await fetch(app + '/api/migration-state')).json();
    const deployment = (await fetch(app + '/')).headers.get('x-casimir-deployment');
    const files = await readdir(root + '/db/migrations');
    const index = 1 + Math.max(...files.map((name) => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    const name = String(index).padStart(4, '0') + '_job_crash.sql';
    await writeFile(
      root + '/db/migrations/' + name,
      `CREATE TABLE job_crash_${index} (id INTEGER PRIMARY KEY);\n`,
    );
    const op = await cli(true);
    assert.equal(op.phase, 'failed');
    assert.equal(op.outcome, 'rejected');
    assert.equal(op.exposure_started, null);
    assert.equal(op.snapshot_fingerprint, null);
    assert.deepEqual(await (await fetch(app + '/api/migration-state')).json(), before);
    assert.equal((await fetch(app + '/')).headers.get('x-casimir-deployment'), deployment);
    const messages = await (await fetch(app + '/api/messages')).json();
    assert.ok(messages.messages.some((row) => row.text === 'casimir v1 sentinel café 👀'));
    await writeFile(
      root + '/compatibility/check.js',
      await readFile('casimir/examples/notes/compatibility/check.js'),
    );
    console.log(
      JSON.stringify({
        gate: 'owned-job-SIGKILL',
        operationId: op.id,
        phase: op.phase,
        deploymentId: deployment,
        dataUnchanged: true,
      }),
    );
  }
} finally {
  await db.end();
}
