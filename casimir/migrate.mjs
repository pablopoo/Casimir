import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../platform/packages/api/package.json', import.meta.url));
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
try {
  if (!process.env.DATABASE_URL) throw new Error('missing configuration');
  await migrate(drizzle(pool), {
    migrationsFolder:
      process.env.CASIMIR_MIGRATIONS_DIR ??
      fileURLToPath(new URL('../platform/packages/api/drizzle/', import.meta.url)),
  });
  console.log('PostgreSQL migrations applied');
} catch (error) {
  console.error('PostgreSQL migration failed', typeof error.code === 'string' ? error.code : '');
  process.exitCode = 1;
} finally {
  await pool.end();
}
