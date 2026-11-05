import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');

test('readiness refuses a reachable but uninitialized PostgreSQL database', async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    if (
      !(await admin.query("SELECT 1 FROM pg_database WHERE datname='casimir_unmigrated_test'"))
        .rowCount
    )
      await admin.query('CREATE DATABASE casimir_unmigrated_test');
  } finally {
    await admin.end();
  }
  const { createApp, createDb } = await import('../../../../../casimir/dist/checks.mjs');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/casimir_unmigrated_test';
  const db = createDb(url.toString());
  try {
    const app = createApp({ db, token: 'fictional-readiness-token', operatorId: 'nonexistent' });
    assert.equal((await app.request('/health')).status, 503);
  } finally {
    await db.$client.end();
  }
});
