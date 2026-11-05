import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createDb } from '../../db/client.ts';
import { createEngine } from './docker-engine.ts';
import { acquireExecutorGuard } from './guard.ts';
import { loadProfile } from './profile.ts';
import { reconcileStartup } from './reconcile.ts';
import { RouteStore } from './routing.ts';
import { executeOperation } from './runner.ts';
import { pendingOperations, assertExecutionMigrations } from './store.ts';
let pool: Pool | undefined;
let guard: Awaited<ReturnType<typeof acquireExecutorGuard>> | undefined;
try {
  if (!process.env.DATABASE_URL || !process.env.CASIMIR_EXECUTION_PROFILE) throw Error();
  const profile = loadProfile(process.env.CASIMIR_EXECUTION_PROFILE);
  const engine = createEngine({ socketPath: '/var/run/docker.sock', profile });
  await engine.verifyEnvironment();
  const self = await engine.inspectContainer(hostname());
  if (
    !self?.State.Running ||
    self.Config?.Labels?.['org.casimir.task'] !== 'execution-poc' ||
    self.Config.Labels['org.casimir.role'] !== 'executor'
  )
    throw Error();
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    statement_timeout: 5000,
    max: 3,
  });
  pool.on('error', () => {
    void guard?.close();
  });
  const db = createDb(pool);
  await assertExecutionMigrations(db);
  guard = await acquireExecutorGuard({
    connectionString: process.env.DATABASE_URL,
    engine,
    selfContainerId: self.Id,
    selfStartedAt: self.State.StartedAt,
  });
  engine.setGuard(guard);
  const stop = () => {
    void guard?.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const abort = () => {
    setTimeout(() => process.exit(1), 2500).unref();
  };
  guard.signal.addEventListener('abort', abort, { once: true });
  const ctx = { db, engine, profile, guard, routes: new RouteStore('/routes') };
  await reconcileStartup(ctx);
  console.log('Casimir executor guarded');
  while (!guard.signal.aborted) {
    const ops = await pendingOperations(db);
    const next = ops.find((op) => op.phase === 'queued');
    if (next) {
      const result = await executeOperation(ctx, next.id);
      console.log('Casimir operation', result.id, result.phase);
    }
    await delay(500, undefined, { signal: guard.signal });
  }
} catch {
  console.error('Casimir executor stopped without claiming success');
  process.exitCode = 1;
} finally {
  await guard?.close();
  await pool?.end();
}
