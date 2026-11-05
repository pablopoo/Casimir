import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withOperatorSuspension } from './operator-state.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');

test('real Node HTTP preserves ownership, access, policy and pending-record semantics', async (t) => {
  assert.ok(existsSync('casimir/dist/main.mjs'), 'compiled Node API must exist');
  const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:4291';
  const child = process.env.API_BASE_URL
    ? null
    : spawn(process.execPath, ['casimir/dist/main.mjs'], {
        env: { ...process.env, PORT: '4291' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  let output = '';
  child?.stdout.on('data', (b) => {
    output += b;
  });
  child?.stderr.on('data', (b) => {
    output += b;
  });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const stamp = Date.now().toString(36);
  const call = (path, { method = 'GET', body, token = process.env.CASIMIR_TOKEN, raw } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(8000),
    });
  try {
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(base + '/health')).ok) break;
      } catch {}
      if (n === 99) assert.fail('API did not become ready');
      await delay(100);
    }
    await client.connect();
    await t.test('authentication and bounded valid JSON fail closed', async () => {
      assert.equal(
        (await call('/projects', { method: 'POST', body: { slug: 'missing-auth' }, token: null }))
          .status,
        401,
      );
      assert.equal((await call('/projects/x', { token: 'wrong-token' })).status, 401);
      for (const raw of ['{', 'null', '[]', '"text"'])
        assert.equal((await call('/projects', { method: 'POST', raw })).status, 400);
      assert.equal(
        (
          await call('/projects', {
            method: 'POST',
            raw: JSON.stringify({ slug: 'a'.repeat(17000) }),
          })
        ).status,
        413,
      );
    });
    await t.test('slug and plan rules are retained', async () => {
      for (const slug of ['admin', 'preview-sample', 'Bad-Case', 'a'.repeat(57), null, 5])
        assert.equal((await call('/projects', { method: 'POST', body: { slug } })).status, 400);
      assert.equal(
        (await call('/projects', { method: 'POST', body: { slug: 'x' + stamp.slice(-4) } })).status,
        403,
      );
    });
    const slug = 'casimir-http-' + stamp;
    const response = await call('/projects', { method: 'POST', body: { slug } });
    assert.equal(response.status, 201);
    const project = await response.json();
    assert.match(project.id, /^proj_/);
    await t.test('project and ownership persist through real domain code', async () => {
      const fetched = await call('/projects/' + project.id);
      assert.equal(fetched.status, 200);
      assert.equal((await fetched.json()).id, project.id);
      const rows = await client.query(
        'SELECT * FROM project_ownership_periods WHERE project_id=$1 AND ends_at IS NULL',
        [project.id],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].owner_user_id, process.env.CASIMIR_OPERATOR_ID);
      assert.equal((await call('/projects', { method: 'POST', body: { slug } })).status, 409);
    });
    await t.test('concurrent duplicate creation leaves one ownership period', async () => {
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          call('/projects', { method: 'POST', body: { slug: slug + '-race' } }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409, 409]);
      const rows = await client.query(
        'SELECT p.id, count(o.id)::int AS periods FROM projects p JOIN project_ownership_periods o ON o.project_id=p.id WHERE p.slug=$1 GROUP BY p.id',
        [slug + '-race'],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].periods, 1);
    });
    await t.test('record creation preserves attribution and never activates', async () => {
      const r = await call(`/projects/${project.id}/deployments`, { method: 'POST', body: {} });
      assert.equal(r.status, 201);
      const record = await r.json();
      assert.equal(record.status, 'pending');
      assert.equal(record.initiated_by_user_id, process.env.CASIMIR_OPERATOR_ID);
      assert.equal(record.billing_user_id, process.env.CASIMIR_OPERATOR_ID);
      const list = await (await call(`/projects/${project.id}/deployments`)).json();
      assert.equal(list.activeDeploymentId, null);
      assert.ok(list.deployments.some((d) => d.id === record.id && d.status === 'pending'));
      const dbrow = (await client.query('SELECT * FROM deployments WHERE id=$1', [record.id]))
        .rows[0];
      assert.equal(dbrow.project_id, project.id);
      assert.equal(
        (await client.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project.id]))
          .rows[0].active_deployment_id,
        null,
      );
      assert.equal(
        (await call(`/projects/${project.id}/deploy`, { method: 'POST', body: {} })).status,
        501,
      );
      assert.equal(
        (
          await call(`/projects/${project.id}/deployments`, {
            method: 'POST',
            body: { image: 'arbitrary' },
          })
        ).status,
        400,
      );
    });
    await t.test('suspension and project access are live checks', async () => {
      const { createApp, createDb } = await import('../../../../../casimir/dist/checks.mjs');
      const isolatedDb = createDb(process.env.DATABASE_URL);
      try {
        const withoutOperator = createApp({
          db: isolatedDb,
          token: process.env.CASIMIR_TOKEN,
          operatorId: 'casimir_operator_missing',
        });
        assert.equal(
          (
            await withoutOperator.request('/projects/' + project.id, {
              headers: { Authorization: `Bearer ${process.env.CASIMIR_TOKEN}` },
            })
          ).status,
          401,
        );
      } finally {
        await isolatedDb.$client.end();
      }
      await withOperatorSuspension(
        client,
        process.env.CASIMIR_OPERATOR_ID,
        'test_admin_suspend',
        async () => {
          assert.equal((await call('/projects/' + project.id)).status, 403);
        },
      );
      const other = 'casimir_foreign_' + stamp,
        foreign = 'proj_foreign' + stamp;
      await client.query(
        "INSERT INTO users (id,provider,provider_id,login) VALUES ($1,'casimir-test',$1,'fictional')",
        [other],
      );
      await client.query('INSERT INTO projects (id,user_id,slug) VALUES ($1,$2,$3)', [
        foreign,
        other,
        'foreign-' + stamp,
      ]);
      assert.equal((await call('/projects/' + foreign)).status, 403);
      assert.equal(
        (await call(`/projects/${foreign}/deployments`, { method: 'POST', body: {} })).status,
        403,
      );
      assert.equal((await call('/projects/proj_nonexistent')).status, 404);
    });
    await t.test('deleting and inconsistent projects reject new records', async () => {
      const original = (await client.query('SELECT status FROM projects WHERE id=$1', [project.id]))
        .rows[0].status;
      try {
        await client.query("UPDATE projects SET status='deleting' WHERE id=$1", [project.id]);
        assert.equal(
          (await call(`/projects/${project.id}/deployments`, { method: 'POST', body: {} })).status,
          410,
        );
        await client.query(
          "UPDATE projects SET status=$2,active_deployment_id='dpl_nonexistent' WHERE id=$1",
          [project.id, original],
        );
        assert.equal(
          (await call(`/projects/${project.id}/deployments`, { method: 'POST', body: {} })).status,
          409,
        );
      } finally {
        await client.query('UPDATE projects SET status=$2,active_deployment_id=NULL WHERE id=$1', [
          project.id,
          original,
        ]);
      }
    });
  } finally {
    await client.end();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    assert.ok(
      !output.includes(process.env.CASIMIR_TOKEN),
      'token must not appear in server output',
    );
  }
});
