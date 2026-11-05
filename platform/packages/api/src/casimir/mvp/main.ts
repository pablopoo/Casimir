import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { assertCasimirRuntime } from '@void/deploy-core';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDb } from '../../db/client.ts';
import { acquireExecutorGuard, type ExecutorGuard } from '../execution/guard.ts';
import { MvpEngine } from './engine.ts';
import { loadMvpProfile } from './profile.ts';
import { cleanupMvpOperationJobs } from './reconcile.ts';
import { MvpRouteStore } from './routing.ts';
import { runMvpOperation } from './runner.ts';
import { mvpOperationById } from './runner.ts';
import { assertMvpMigrations } from './store.ts';
import { reconcileInstallationStartup } from '../lifecycle/startup.ts';
import {expireMvpUploadBatch} from './artifacts.ts';
let pool: Pool | undefined, guard: ExecutorGuard | undefined;
try {
  if (!process.env.DATABASE_URL || !process.env.CASIMIR_MVP_PROFILE) {
    throw Error();
  }
  const profile = loadMvpProfile(process.env.CASIMIR_MVP_PROFILE);
  const runner = JSON.parse(await readFile('/config/runner.json', 'utf8'));
  assertCasimirRuntime(runner.runtime, profile.runtime);
  const engine = new MvpEngine({
    socketPath: '/var/run/docker.sock',
    runnerImage: runner.imageId,
    runtime: profile.runtime,
    installationId: profile.installationId,
    appOrigin: profile.origins?.app,
  });
  await engine.verifyEnvironment();
  const self = await engine.inspectContainer(hostname());
  if (
    !self?.State.Running ||
    (profile.installationId ? self.Config?.Labels?.['org.casimir.installation'] !== profile.installationId : self.Config?.Labels?.['org.casimir.task'] !== 'mvp-a') ||
    self.Config.Labels['org.casimir.role'] !== 'executor'
  ) {
    throw Error();
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    statement_timeout: 5000,
    max: 3,
  });
  pool.on('error', () => void guard?.close());
  const db = createDb(pool);
  await assertMvpMigrations(db);
  guard = await acquireExecutorGuard({
    connectionString: process.env.DATABASE_URL,
    engine,
    selfContainerId: self.Id,
    selfStartedAt: self.State.StartedAt,
    guardProfile: 'mvp-a',
  });
  engine.setGuard(guard);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => void guard?.close());
  }
  guard.signal.addEventListener('abort', () => setTimeout(() => process.exit(1), 2000).unref(), {
    once: true,
  });
  const routes = new MvpRouteStore('/routes');
  await routes.read();
  const ctx = {
    db,
    guard,
    engine,
    profile,
    routes,
    artifactRoot: profile.artifactRoot,
    failpoint: async (name: string) => {
      if (process.env.CASIMIR_TEST_FAILPOINT === name) {
        console.log('casimir_failpoint', name);
        await new Promise<void>(() => {});
      }
    },
  };
  console.log('Casimir MVP executor guarded');
  if (profile.installationId) {
    const startup = await reconcileInstallationStartup(ctx);
    console.log('Casimir installation startup', startup.code);
  }
  const terminal = await db.execute<{ id: string }>(
    sql`SELECT id FROM casimir_mvp_a.operations WHERE phase IN ('succeeded','failed') ORDER BY created_at`,
  );
  for (const row of terminal.rows) {
    await cleanupMvpOperationJobs(ctx, await mvpOperationById(ctx, row.id));
  }
  let nextExpiry=Date.now()+60000,expiryCursor='';
  while (!guard.signal.aborted) {
    if (profile.installationId) {
      const installation = await db.execute<{installation_id: string; phase: string}>(sql`SELECT installation_id,phase FROM casimir_install.installation WHERE id=1`);
      if (installation.rows[0]?.installation_id !== profile.installationId) throw new Error('installation_identity');
      if (installation.rows[0].phase !== 'ready') {
        const drain = installation.rows[0].phase === 'maintenance' ? await db.execute(sql`SELECT id FROM casimir_install.maintenance WHERE installation_id=${profile.installationId} AND kind='stop' AND phase='requested' LIMIT 1`) : {rows:[]};
        if(!drain.rows.length){await delay(500, undefined, { signal: guard.signal });continue;}
      }
    }
    if(profile.installationId&&Date.now()>=nextExpiry){
      const expired=await expireMvpUploadBatch(db,profile,expiryCursor,()=>guard!.assertLive());
      expiryCursor=expired.cursor;nextExpiry=Date.now()+60000;
      console.log('Casimir bounded upload expiry',expired.count);
    }
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed','recovery_required') ORDER BY created_at LIMIT 1`,
    );
    if (rows.rows[0]) {
      const result = await runMvpOperation(ctx, rows.rows[0].id);
      await cleanupMvpOperationJobs(ctx, result);
      console.log('Casimir MVP operation', result.id, result.phase);
    }
    await delay(500, undefined, { signal: guard.signal });
  }
} catch {
  console.error('Casimir MVP executor stopped without claiming success');
  process.exitCode = 1;
} finally {
  await guard?.close();
  await pool?.end();
}
