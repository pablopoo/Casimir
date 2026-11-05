import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { isAbsolute } from 'pathslash';
import { getRawRuntimeEnv } from './env.ts';

export type { BetterSQLite3Database };
export {
  sql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  asc,
  desc,
  like,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  count,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';

const key = Symbol.for('casimir.sqliteConnections.v1');
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Database.Database> };
const connections = (globals[key] ??= new Map());

export function getCasimirDbPath(): string {
  const path = getRawRuntimeEnv().CASIMIR_SQLITE_PATH;
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('casimir: native database path is unavailable.');
  }
  return path;
}

export function openCasimirDb<T extends Record<string, unknown>>(
  path: string,
  schema: T,
): BetterSQLite3Database<T> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('casimir: invalid database path.');
  }
  let connection = connections.get(path);
  if (!connection) {
    connection = new Database(path);
    connection.pragma('foreign_keys = ON');
    connections.set(path, connection);
  }
  return drizzle(connection, { schema });
}
