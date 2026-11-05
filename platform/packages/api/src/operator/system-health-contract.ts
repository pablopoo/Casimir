import { sql } from 'drizzle-orm';
import type { Db } from '../db.ts';

export type HealthCheck = Readonly<{
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}>;

export type HealthResult = Readonly<{
  checks: ReadonlyArray<HealthCheck>;
  allOk: boolean;
}>;

export function systemHealthCheckNames(installed: boolean): ReadonlyArray<string> {
  return ['api', 'proxy', ...(installed ? [] : ['dashboard']), 'dispatch', 'db'];
}

export async function checkDatabaseHealth(db: Db): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { name: 'db', ok: true, latencyMs: Date.now() - start };
  } catch {
    return {
      name: 'db',
      ok: false,
      latencyMs: Date.now() - start,
      error: 'Database query failed.',
    };
  }
}
