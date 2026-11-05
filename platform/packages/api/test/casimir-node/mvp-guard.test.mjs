import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withMvpControl } from './mvp-support.mjs';
test('MVP guard is independent from legacy scope and retains fail-closed session/incarnation checks', async () =>
  withMvpControl(async ({ db, env }) => {
    assert.equal(
      spawnSync(process.execPath, ['casimir/migrate-execution.mjs'], { env, encoding: 'utf8' })
        .status,
      0,
    );
    let running = true;
    const engine = {
      async inspectContainer(id) {
        return { Id: id, State: { Running: running, StartedAt: 'first' } };
      },
    };
    const options = {
      connectionString: env.DATABASE_URL,
      engine,
      selfContainerId: 'a'.repeat(64),
      selfStartedAt: 'first',
    };
    const mvp = await checks.acquireExecutorGuard({ ...options, guardProfile: 'mvp-a' });
    let legacy;
    try {
      assert.equal(
        (await db.query('SELECT scope FROM casimir_mvp_a.executor_guard')).rows[0].scope,
        'casimir-mvp-a',
      );
      legacy = await checks.acquireExecutorGuard({ ...options, selfContainerId: 'b'.repeat(64) });
      legacy.assertLive();
      await assert.rejects(
        checks.acquireExecutorGuard({ ...options, guardProfile: 'mvp-a' }),
        (e) => e.code === 'executor_busy',
      );
      const locks = await db.query(
        "SELECT pid,objid FROM pg_locks WHERE locktype='advisory' AND classid=1128354643 AND objid IN(1,5) AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
      );
      assert.equal(locks.rows.length, 2);
      await db.query('SELECT pg_terminate_backend($1)', [
        locks.rows.find((r) => r.objid === 5).pid,
      ]);
      for (let i = 0; i < 50 && !mvp.signal.aborted; i++) {
        await delay(50);
      }
      assert.equal(mvp.signal.aborted, true);
      assert.throws(() => mvp.assertLive());
      legacy.assertLive();
      await assert.rejects(
        checks.acquireExecutorGuard({ ...options, guardProfile: 'mvp-a' }),
        (e) => e.code === 'executor_previous_owner_running',
      );
      running = false;
      const next = await checks.acquireExecutorGuard({ ...options, guardProfile: 'mvp-a' });
      await next.close();
    } finally {
      await mvp.close();
      await legacy?.close();
    }
  }));
