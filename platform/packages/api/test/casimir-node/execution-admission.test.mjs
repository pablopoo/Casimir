import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTestControl, projectAndDeployment } from './execution-support.mjs';
test('separate execution migrations are present and rerun without deleting intent', async () => {
  await withTestControl(async ({ db }) => {
    const r = await db.query("SELECT to_regclass('casimir.execution_operations') AS relation");
    assert.ok(r.rows[0].relation, 'durable execution journal must be migrated');
    const history = await db.query('SELECT version, hash FROM casimir.schema_migrations');
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].version, 1);
    assert.match(history.rows[0].hash, /^[a-f0-9]{64}$/);
  });
});
test('real HTTP admits one intent, preserves attribution, and rejects conflicting execution', async () => {
  await withTestControl(async ({ db, request }) => {
    const { project, deployment } = await projectAndDeployment(request, 'execution-admission');
    const path = '/projects/' + project.id + '/deployments/' + deployment.id + '/execute';
    const [first, retry] = await Promise.all([
      request(path, { imageAlias: 'demo-v1' }, 'one'),
      request(path, { imageAlias: 'demo-v1' }, 'one'),
    ]);
    assert.equal(first.status, 202);
    assert.equal(retry.status, 202);
    assert.equal(first.body.operationId, retry.body.operationId);
    assert.equal(first.body.phase, 'queued');
    let rows = await db.query('SELECT * FROM casimir.execution_operations');
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].actor_id, 'casimir_test_operator');
    const state = await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [
      project.id,
    ]);
    assert.equal(state.rows[0].active_deployment_id, null);
    assert.equal((await request(path, { imageAlias: 'demo-v2' }, 'one')).status, 409);
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'two')).status, 409);
    const another = await request('/projects/' + project.id + '/deployments', {});
    assert.equal(another.status, 201);
    assert.equal(
      (
        await request(
          '/projects/' + project.id + '/deployments/' + another.body.id + '/execute',
          { imageAlias: 'demo-v1' },
          'one',
        )
      ).status,
      409,
    );
    for (const body of [
      { imageAlias: 'node:latest' },
      { imageAlias: 'demo-v1', command: 'sh' },
      {},
    ])
      assert.equal((await request(path, body, 'invalid')).status, 400);
    for (const key of [undefined, '', 'x'.repeat(129), 'bad\tkey', 'clé'])
      assert.equal((await request(path, { imageAlias: 'demo-v1' }, key)).status, 400);
    const receipt = await request(
      '/projects/' + project.id + '/operations/' + first.body.operationId,
    );
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.phase, 'queued');
    const second = await projectAndDeployment(request, 'another-execution-project');
    assert.equal(
      (await request('/projects/' + second.project.id + '/operations/' + first.body.operationId))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          '/projects/' + second.project.id + '/deployments/' + second.deployment.id + '/execute',
          { imageAlias: 'demo-v1' },
          'other',
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          '/projects/' + project.id + '/deployments/' + second.deployment.id + '/execute',
          { imageAlias: 'demo-v1' },
          'foreign',
        )
      ).status,
      404,
    );
    await db.query(
      "UPDATE users SET suspended_reason='admin:test' WHERE id='casimir_test_operator'",
    );
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'one')).status, 403);
  });
});
test('execution admission rejects stale or foreign deployment state before writing intent', async () => {
  await withTestControl(async ({ db, request }) => {
    const { project, deployment } = await projectAndDeployment(request, 'execution-state-checks');
    const path = '/projects/' + project.id + '/deployments/' + deployment.id + '/execute';
    await db.query("UPDATE deployments SET status='failed' WHERE id=$1", [deployment.id]);
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'state')).status, 409);
    await db.query("UPDATE deployments SET status='pending',source='foreign' WHERE id=$1", [
      deployment.id,
    ]);
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'state')).status, 409);
    await db.query("UPDATE deployments SET source='casimir-record' WHERE id=$1", [deployment.id]);
    await db.query("UPDATE projects SET status='deleting' WHERE id=$1", [project.id]);
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'state')).status, 410);
    await db.query(
      "UPDATE projects SET status='active',active_deployment_id='dpl_missing' WHERE id=$1",
      [project.id],
    );
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'state')).status, 409);
    await db.query('UPDATE projects SET active_deployment_id=NULL WHERE id=$1', [project.id]);
    await db.query(
      "INSERT INTO users(id,provider,provider_id,login,email,plan,role) VALUES ('foreign_execution_user','casimir-local','foreign_execution_user','foreign-test','foreign@example.invalid','free','admin')",
    );
    await db.query("UPDATE projects SET user_id='foreign_execution_user' WHERE id=$1", [
      project.id,
    ]);
    assert.equal((await request(path, { imageAlias: 'demo-v1' }, 'state')).status, 403);
    const rows = await db.query('SELECT count(*)::int AS count FROM casimir.execution_operations');
    assert.equal(rows.rows[0].count, 0);
  });
});
test('terminal retries preserve receipt; SQL enforces operation exclusivity and migration readiness', async () => {
  await withTestControl(async ({ db, request, env, baseUrl }) => {
    const { project, deployment } = await projectAndDeployment(request, 'execution-journal-rules');
    const path = '/projects/' + project.id + '/deployments/' + deployment.id + '/execute';
    const first = await request(path, { imageAlias: 'demo-v1' }, 'durable');
    assert.equal(first.status, 202);
    const second = await request('/projects/' + project.id + '/deployments', {});
    const columns =
      'id,project_id,deployment_id,actor_id,idempotency_key,input_hash,image_alias,image_id,profile_hash';
    const insert =
      'INSERT INTO casimir.execution_operations(' +
      columns +
      ") SELECT 'cex_abcdefghijkl',project_id,$1,actor_id,$2,input_hash,image_alias,image_id,profile_hash FROM casimir.execution_operations WHERE id=$3";
    await assert.rejects(
      db.query(insert, [deployment.id, 'other', first.body.operationId]),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      db.query(insert, [second.body.id, 'durable', first.body.operationId]),
      (e) => e.code === '23505',
    );
    await assert.rejects(
      db.query(insert, [second.body.id, 'other', first.body.operationId]),
      (e) => e.code === '23505',
    );
    await db.query(
      "UPDATE casimir.execution_operations SET phase='failed',outcome='rejected' WHERE id=$1",
      [first.body.operationId],
    );
    await db.query("UPDATE deployments SET status='failed' WHERE id=$1", [deployment.id]);
    const retry = await request(path, { imageAlias: 'demo-v1' }, 'durable');
    assert.equal(retry.status, 202);
    assert.equal(retry.body.operationId, first.body.operationId);
    assert.equal(retry.body.phase, 'failed');
    const { spawnSync } = await import('node:child_process');
    const rerun = spawnSync(process.execPath, ['casimir/migrate-execution.mjs'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM casimir.execution_operations')).rows[0].n,
      1,
    );
    await db.query("UPDATE casimir.schema_migrations SET hash=repeat('0',64)");
    assert.equal((await fetch(baseUrl + '/health')).status, 503);
    const mismatch = spawnSync(process.execPath, ['casimir/migrate-execution.mjs'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /migration failed/);
  });
});
test('record-only mode returns authenticated 501; invalid additive SQL rolls back completely', async () => {
  await withTestControl(async ({ db, env }) => {
    const { createApp, createDb } = await import('../../../../../casimir/dist/checks.mjs');
    const orm = createDb(env.DATABASE_URL);
    try {
      const app = createApp({
        db: orm,
        token: env.CASIMIR_TOKEN,
        operatorId: env.CASIMIR_OPERATOR_ID,
      });
      const project = await app.request('/projects', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.CASIMIR_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'record-only-execution' }),
      });
      const p = await project.json();
      assert.equal(project.status, 201);
      const path = '/projects/' + p.id + '/deployments/none/execute';
      assert.equal((await app.request(path, { method: 'POST' })).status, 401);
      assert.equal(
        (
          await app.request(path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.CASIMIR_TOKEN },
          })
        ).status,
        501,
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM casimir.execution_operations')).rows[0].n,
        0,
      );
    } finally {
      await orm.$client.end();
    }
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync('/tmp/casimir-invalid-migration-');
    try {
      const file = dir + '/invalid.sql';
      writeFileSync(file, 'CREATE TABLE casimir.must_rollback(id integer); INVALID SQL;');
      await db.query('DROP SCHEMA casimir CASCADE');
      const result = spawnSync(process.execPath, ['casimir/migrate-execution.mjs'], {
        env: { ...env, CASIMIR_EXECUTION_MIGRATION: file },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /migration failed/);
      assert.equal(
        (await db.query("SELECT to_regnamespace('casimir') AS schema")).rows[0].schema,
        null,
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,
        54,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
test('SQL finalization rejects unverified observations, pointer changes, and revoked authority atomically', async () => {
  const checks = await import('../../../../../casimir/dist/checks.mjs');
  assert.equal(
    typeof checks.finalizeSuccess,
    'function',
    'conditional finalization helper must exist',
  );
  await withTestControl(async ({ db, request, env }) => {
    const orm = checks.createDb(env.DATABASE_URL);
    try {
      const { project, deployment } = await projectAndDeployment(request, 'execution-finalization');
      const admitted = await request(
        '/projects/' + project.id + '/deployments/' + deployment.id + '/execute',
        { imageAlias: 'demo-v1' },
        'sql-finalization',
      );
      assert.equal(admitted.status, 202);
      const instance = 'fixture-instance',
        id = admitted.body.operationId,
        candidate = 'a'.repeat(64);
      const route = {
        target: null,
        fingerprint: '1'.repeat(64),
        observedAt: new Date().toISOString(),
      };
      await checks.claimQueued(orm, id, instance, route);
      await checks.beginCutover(orm, id, instance);
      await checks.setPhase(orm, id, instance, ['cutover'], 'verifying', candidate);
      await assert.rejects(checks.finalizeSuccess(orm, id, instance), /unverified target/);
      const target = {
        projectId: project.id,
        deploymentId: deployment.id,
        containerId: candidate,
        imageId: admitted.body.requestedTarget.imageId,
        version: 'v1',
      };
      // Synthetic observation isolates SQL preconditions; it is never publication evidence.
      await checks.recordObservation(orm, id, instance, {
        target,
        route: { ...route, target },
        healthy: true,
        writable: true,
        loopbackVerified: true,
        observedAt: new Date().toISOString(),
      });
      const other = await request('/projects/' + project.id + '/deployments', {});
      assert.equal(other.status, 201);
      await db.query('UPDATE projects SET active_deployment_id=$1 WHERE id=$2', [
        other.body.id,
        project.id,
      ]);
      await assert.rejects(checks.finalizeSuccess(orm, id, instance), /active pointer conflict/);
      assert.equal(
        (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project.id]))
          .rows[0].active_deployment_id,
        other.body.id,
      );
      await db.query('UPDATE projects SET active_deployment_id=NULL WHERE id=$1', [project.id]);
      await db.query("UPDATE users SET suspended_reason='admin:test' WHERE id=$1", [
        env.CASIMIR_OPERATOR_ID,
      ]);
      await assert.rejects(checks.finalizeSuccess(orm, id, instance), /account suspended/);
      const op = (
        await db.query('SELECT phase,outcome FROM casimir.execution_operations WHERE id=$1', [id])
      ).rows[0];
      assert.equal(op.phase, 'verifying');
      assert.equal(op.outcome, null);
      assert.equal(
        (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project.id]))
          .rows[0].active_deployment_id,
        null,
      );
    } finally {
      await orm.$client.end();
    }
  });
});
test('resumed preflight rechecks live permission and pending source before Docker effects', async () => {
  const checks = await import('../../../../../casimir/dist/checks.mjs');
  assert.equal(typeof checks.validatePreflight, 'function');
  await withTestControl(async ({ db, request, env }) => {
    const orm = checks.createDb(env.DATABASE_URL);
    try {
      const { project, deployment } = await projectAndDeployment(request, 'resumed-preflight');
      const admitted = await request(
        '/projects/' + project.id + '/deployments/' + deployment.id + '/execute',
        { imageAlias: 'demo-v1' },
        'resume',
      );
      assert.equal(admitted.status, 202);
      await checks.claimQueued(orm, admitted.body.operationId, 'fixture-instance', {
        target: null,
        fingerprint: '1'.repeat(64),
        observedAt: new Date().toISOString(),
      });
      await db.query("UPDATE users SET suspended_reason='admin:test' WHERE id=$1", [
        env.CASIMIR_OPERATOR_ID,
      ]);
      await assert.rejects(
        checks.validatePreflight(orm, admitted.body.operationId, 'fixture-instance'),
        /account suspended/,
      );
      await db.query('UPDATE users SET suspended_reason=NULL WHERE id=$1', [
        env.CASIMIR_OPERATOR_ID,
      ]);
      await db.query("UPDATE deployments SET source='foreign' WHERE id=$1", [deployment.id]);
      await assert.rejects(
        checks.validatePreflight(orm, admitted.body.operationId, 'fixture-instance'),
        /deployment state conflict/,
      );
    } finally {
      await orm.$client.end();
    }
  });
});
test('controlled missing previous image blocks compensation without changing SQL pointer or route', async () => {
  const checks = await import('../../../../../casimir/dist/checks.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  await withTestControl(async ({ db, request, env }) => {
    const orm = checks.createDb(env.DATABASE_URL),
      dir = mkdtempSync('/tmp/casimir-compensation-unit-');
    try {
      const { project, deployment } = await projectAndDeployment(
        request,
        'unrestorable-compensation',
      );
      const first = await request(
        '/projects/' + project.id + '/deployments/' + deployment.id + '/execute',
        { imageAlias: 'demo-v1' },
        'previous',
      );
      assert.equal(first.status, 202);
      await db.query(
        "UPDATE casimir.execution_operations SET phase='succeeded',outcome='activated' WHERE id=$1",
        [first.body.operationId],
      );
      await db.query("UPDATE deployments SET status='live' WHERE id=$1", [deployment.id]);
      await db.query('UPDATE projects SET active_deployment_id=$1 WHERE id=$2', [
        deployment.id,
        project.id,
      ]);
      const d = await request('/projects/' + project.id + '/deployments', {});
      assert.equal(d.status, 201);
      const admitted = await request(
        '/projects/' + project.id + '/deployments/' + d.body.id + '/execute',
        { imageAlias: 'demo-v2' },
        'unrestorable',
      );
      assert.equal(admitted.status, 202);
      const target = {
        projectId: project.id,
        deploymentId: deployment.id,
        containerId: 'a'.repeat(64),
        imageId: first.body.requestedTarget.imageId,
        version: 'v1',
      };
      const routes = new checks.RouteStore(dir);
      await routes.initialize();
      const route = await routes.replace(await routes.read(), target);
      await checks.claimQueued(orm, admitted.body.operationId, 'prior-instance', route);
      await checks.beginCutover(orm, admitted.body.operationId, 'prior-instance');
      let mutations = 0;
      const unexpected = async () => {
        mutations++;
        throw Error('unexpected Docker mutation');
      };
      // Controlled dependency failure tests SQL/file guards, not publication or real Docker availability.
      const engine = {
        candidateName: (op) => 'casimir-execution-poc-app-' + op.id,
        inspectContainer: async () => null,
        validateRecordedTarget: async () => {
          throw Error('docker_not_found');
        },
        start: unexpected,
        stop: unexpected,
        removeOwned: unexpected,
        reloadProxy: unexpected,
        runLoopbackProbe: unexpected,
      };
      const result = await checks.reconcileOperation(
        {
          db: orm,
          engine,
          profile: checks.loadProfile(env.CASIMIR_EXECUTION_PROFILE),
          guard: { instance: 'replacement', signal: new AbortController().signal, assertLive() {} },
          routes,
        },
        admitted.body.operationId,
      );
      assert.equal(result.phase, 'recovery_required');
      assert.equal(result.outcome, null);
      assert.equal(mutations, 0);
      assert.equal((await routes.read()).fingerprint, route.fingerprint);
      assert.equal(
        (await db.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project.id]))
          .rows[0].active_deployment_id,
        deployment.id,
      );
      const next = await request('/projects/' + project.id + '/deployments', {});
      assert.equal(next.status, 201);
      assert.equal(
        (
          await request(
            '/projects/' + project.id + '/deployments/' + next.body.id + '/execute',
            { imageAlias: 'demo-v1' },
            'blocked',
          )
        ).status,
        409,
      );
    } finally {
      await orm.$client.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
