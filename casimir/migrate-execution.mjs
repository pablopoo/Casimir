import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../platform/packages/api/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  query_timeout: 10000,
});
try {
  if (!process.env.DATABASE_URL) throw new Error();
  const file =
    process.env.CASIMIR_EXECUTION_MIGRATION ??
    fileURLToPath(new URL('./execution-migrations/0001_execution.sql', import.meta.url));
  const source = readFileSync(file, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(1128354643,2)');
  await client.query('CREATE SCHEMA IF NOT EXISTS casimir');
  await client.query(
    'CREATE TABLE IF NOT EXISTS casimir.schema_migrations(version integer PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = await client.query(
    'SELECT version,hash FROM casimir.schema_migrations ORDER BY version',
  );
  if (applied.rowCount) {
    if (applied.rowCount !== 1 || applied.rows[0].version !== 1 || applied.rows[0].hash !== hash)
      throw new Error();
  } else {
    await client.query(source);
    await client.query('INSERT INTO casimir.schema_migrations(version,hash) VALUES (1,$1)', [hash]);
  }
  await client.query('COMMIT');
  console.log('Casimir execution migration verified');
} catch {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Casimir execution migration failed');
  process.exitCode = 1;
} finally {
  await client.end();
}
