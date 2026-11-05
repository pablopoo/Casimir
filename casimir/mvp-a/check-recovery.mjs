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
const [mode, point] = process.argv.slice(2);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const state = async () => {
  const r = await fetch(app + '/api/migration-state');
  assert.equal(r.status, 200);
  return r.json();
};
const messages = async () => {
  const r = await fetch(app + '/api/messages');
  assert.equal(r.status, 200);
  return (await r.json()).messages;
};
try {
  if (mode === 'start') {
    const before = await state();
    const names = await readdir(root + '/db/migrations');
    const index = 1 + Math.max(...names.map((name) => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    const name = String(index).padStart(4, '0') + '_recovery.sql';
    await writeFile(
      root + '/db/migrations/' + name,
      `CREATE TABLE recovery_${index} (id INTEGER PRIMARY KEY,value TEXT);\n`,
    );
    await writeFile(
      root + '/routes/api/version.ts',
      `import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:${JSON.stringify(point)}}));\n`,
    );
    await writeFile('.local/mvp-a/recovery-state.json', JSON.stringify({ point, before, name }));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['casimir/mvp-a/check-cli.mjs', 'update'], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('recovery_cli_failed_' + code)),
      );
    });
    const retry = await json(root + '/.void/casimir.retry.json');
    const op = (
      await db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [
        retry.receipt.operationId,
      ])
    ).rows[0];
    assert.equal(op.phase, 'succeeded');
    assert.equal(op.outcome, 'activated');
    assert.ok(op.compatibility_proof?.passed);
    const after = await state();
    assert.equal(after.migrations.length, before.migrations.length + 1);
    assert.deepEqual(after.migrations.slice(0, before.migrations.length), before.migrations);
    assert.equal(after.migrations.filter((row) => row.name === name).length, 1);
    const response = await fetch(app + '/');
    assert.equal(response.headers.get('x-casimir-deployment'), op.deployment_id);
    assert.equal(response.headers.get('x-casimir-image'), op.image_id);
    const project = (
      await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [op.project_id])
    ).rows[0];
    assert.equal(project.active_deployment_id, op.deployment_id);
    const rows = await messages();
    assert.ok(rows.some((row) => row.text === 'casimir v1 sentinel café 👀'));
    if (point === 'after_gate_open') {
      assert.equal(rows.filter((row) => row.text === 'post-exposure ' + op.id).length, 1);
    }
    assert.equal(
      Object.values(op.previous_target.jobs).filter((row) => row.action === 'restore').length,
      0,
    );
    console.log(
      JSON.stringify({
        point,
        operationId: op.id,
        phase: op.phase,
        deploymentId: op.deployment_id,
        imageId: op.image_id,
        migration: name,
      }),
    );
  } else if (mode === 'observe') {
    const saved = await json('.local/mvp-a/recovery-state.json');
    assert.equal(saved.point, point);
    const ops = await db.query(
      "SELECT * FROM casimir_mvp_a.operations WHERE phase NOT IN ('failed','succeeded') ORDER BY created_at DESC",
    );
    assert.equal(ops.rows.length, 1);
    const op = ops.rows[0];
    assert.equal(
      op.phase,
      {
        after_old_stop: 'maintenance',
        guard_loss: 'maintenance',
        after_sqlite_commit: 'migrating',
        before_gate_open: 'exposure_started',
        after_gate_open: 'exposure_started',
      }[point],
    );
    if (point === 'after_gate_open') {
      const r = await fetch(app + '/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'post-exposure ' + op.id }),
      });
      assert.equal(r.status, 200);
      assert.equal(
        (await messages()).filter((row) => row.text === 'post-exposure ' + op.id).length,
        1,
      );
    } else {
      assert.equal((await fetch(app + '/')).status, 503);
    }
    console.log(
      JSON.stringify({
        paused: point,
        operationId: op.id,
        phase: op.phase,
        exposureStarted: op.exposure_started,
      }),
    );
  } else if (mode === 'lose-guard') {
    const locks = await db.query(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1128354643 AND objid=5 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    );
    assert.equal(locks.rows.length, 1);
    assert.equal(
      (await db.query('SELECT pg_terminate_backend($1) AS terminated', [locks.rows[0].pid])).rows[0]
        .terminated,
      true,
    );
    console.log('Terminated exact MVP executor guard session');
  } else if (mode === 'retained') {
    const before = await json('.local/mvp-a/restart-state.json');
    const after = {
      state: await state(),
      messages: await messages(),
      deployment: (await fetch(app + '/')).headers.get('x-casimir-deployment'),
    };
    assert.deepEqual(after, before);
    console.log(
      'API/executor/app/PostgreSQL restart preserved exact data/history/serving identity',
    );
  } else if (mode === 'snapshot') {
    await writeFile(
      '.local/mvp-a/restart-state.json',
      JSON.stringify({
        state: await state(),
        messages: await messages(),
        deployment: (await fetch(app + '/')).headers.get('x-casimir-deployment'),
      }),
    );
  } else {
    throw new Error('unknown_mode');
  }
} finally {
  await db.end();
}
