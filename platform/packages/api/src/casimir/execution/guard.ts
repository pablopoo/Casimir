import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
export class GuardError extends Error {
  constructor(
    readonly code:
      | 'executor_busy'
      | 'executor_previous_owner_running'
      | 'executor_owner_unknown'
      | 'executor_session_lost',
  ) {
    super(code);
  }
}
export interface ExecutorGuard {
  instance: string;
  signal: AbortSignal;
  assertLive(): void;
  close(): Promise<void>;
}
export async function acquireExecutorGuard({
  connectionString,
  engine,
  selfContainerId,
  selfStartedAt,
  guardProfile = 'execution-poc',
}: {
  connectionString: string;
  engine: { inspectContainer(id: string): Promise<any> };
  selfContainerId: string;
  selfStartedAt: string;
  guardProfile?: 'execution-poc' | 'mvp-a';
}): Promise<ExecutorGuard> {
  if (guardProfile !== 'execution-poc' && guardProfile !== 'mvp-a') {
    throw new GuardError('executor_owner_unknown');
  }
  // Only these operator-owned constants may select SQL identifiers/lock scope.
  const config =
    guardProfile === 'mvp-a'
      ? { table: 'casimir_mvp_a.executor_guard', scope: 'casimir-mvp-a', lock: 5 }
      : { table: 'casimir.executor_guard', scope: 'casimir-execution-poc', lock: 1 };
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    application_name: 'casimir-executor-guard',
  });
  const controller = new AbortController();
  const lost = () => controller.abort(new GuardError('executor_session_lost'));
  client.on('error', lost);
  client.on('end', lost);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock(1128354643,$1) AS acquired', [
      config.lock,
    ]);
    if (!lock.rows[0].acquired) throw new GuardError('executor_busy');
    const old = (await client.query(`SELECT * FROM ${config.table} WHERE scope=$1`, [config.scope]))
      .rows[0];
    if (old) {
      let prior;
      try {
        prior = await engine.inspectContainer(old.container_id);
      } catch {
        throw new GuardError('executor_owner_unknown');
      }
      if (
        prior?.State?.Running &&
        !(
          old.container_id === selfContainerId &&
          prior.State.StartedAt !== old.started_at &&
          prior.State.StartedAt === selfStartedAt
        )
      )
        throw new GuardError('executor_previous_owner_running');
    }
    const instance = randomUUID();
    await client.query(
      `INSERT INTO ${config.table}(scope,container_id,started_at,instance) VALUES ($1,$2,$3,$4) ON CONFLICT(scope) DO UPDATE SET container_id=excluded.container_id,started_at=excluded.started_at,instance=excluded.instance,updated_at=now()`,
      [config.scope, selfContainerId, selfStartedAt, instance],
    );
    let checking = false;
    timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void client
        .query('SELECT 1')
        .catch(lost)
        .finally(() => {
          checking = false;
        });
    }, 500);
    return {
      instance,
      signal: controller.signal,
      assertLive() {
        if (controller.signal.aborted) throw new GuardError('executor_session_lost');
      },
      async close() {
        if (timer) clearInterval(timer);
        lost();
        await client.end().catch(() => {});
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    await client.end().catch(() => {});
    throw error;
  }
}
