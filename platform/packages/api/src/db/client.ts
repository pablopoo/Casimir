import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../schema.ts';

export function createDb(connectionString: string | Pool) {
  return drizzle(connectionString, { schema });
}

/** Query surface shared by database clients and transaction handles. */
export type Db = NodePgDatabase<typeof schema>;

/** The transaction handle inside `db.transaction` — same query surface, savepoint-nested. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type DbOrTx = Db | Tx;
