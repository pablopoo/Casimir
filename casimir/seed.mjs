import { createRequire } from 'node:module';
const require = createRequire(new URL('../platform/packages/api/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
try {
  if (!process.env.DATABASE_URL || !process.env.CASIMIR_OPERATOR_ID)
    throw new Error('missing configuration');
  await client.connect();
  await client.query(
    `INSERT INTO users (id, provider, provider_id, login, email, plan, role)
    VALUES ($1, 'casimir-local', $1, 'local-operator', 'operator@example.invalid', 'free', 'admin')
    ON CONFLICT (id) DO NOTHING`,
    [process.env.CASIMIR_OPERATOR_ID],
  );
  console.log('Local operator seed checked');
} catch (error) {
  console.error('Local operator seed failed', typeof error.code === 'string' ? error.code : '');
  process.exitCode = 1;
} finally {
  await client.end();
}
