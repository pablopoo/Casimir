import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withTestControl } from './execution-support.mjs';
test('dedicated executor session prevents concurrent ownership and fails closed after session loss', async () => {
  assert.equal(typeof checks.acquireExecutorGuard, 'function', 'executor guard must exist');
  await withTestControl(async ({ db, env }) => {
    let running = true;
    const engine = {
      inspectContainer: async (id) => ({
        Id: id,
        State: { Running: running, StartedAt: 'incarnation-1' },
        Config: { Labels: { 'org.casimir.task': 'execution-poc', 'org.casimir.role': 'executor' } },
      }),
    };
    const options = {
      connectionString: env.DATABASE_URL,
      engine,
      selfContainerId: 'a'.repeat(64),
      selfStartedAt: 'incarnation-1',
    };
    const guard = await checks.acquireExecutorGuard(options);
    try {
      await assert.rejects(checks.acquireExecutorGuard(options), (e) => e.code === 'executor_busy');
      const rows = await db.query(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1128354643 AND objid=1 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
      );
      assert.equal(rows.rowCount, 1);
      await db.query('SELECT pg_terminate_backend($1)', [rows.rows[0].pid]);
      for (let n = 0; n < 50 && !guard.signal.aborted; n++) await delay(50);
      assert.equal(guard.signal.aborted, true);
      let mutations = 0;
      try {
        guard.assertLive();
        mutations++;
      } catch {}
      assert.equal(mutations, 0);
      await assert.rejects(
        checks.acquireExecutorGuard(options),
        (e) => e.code === 'executor_previous_owner_running',
      );
      await assert.rejects(
        checks.acquireExecutorGuard({
          ...options,
          engine: {
            inspectContainer: async () => {
              throw Error('unknown');
            },
          },
        }),
        (e) => e.code === 'executor_owner_unknown',
      );
      running = false;
      const next = await checks.acquireExecutorGuard(options);
      await next.close();
    } finally {
      await guard.close();
    }
  });
});
