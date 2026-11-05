import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { withTestControl } from './execution-support.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
test('fixture never drops an existing database after CREATE collision', async () => {
  const name = 'casimir_execution_test_' + randomBytes(6).toString('hex');
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  let created = false;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await assert.rejects(
      withTestControl(() => assert.fail('must not run'), { name }),
      /already exists/,
    );
    assert.equal(
      (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rowCount,
      1,
    );
  } finally {
    if (created) await admin.query('DROP DATABASE IF EXISTS "' + name + '"');
    await admin.end();
  }
});
test('fixture closes resources and never attempts DROP after CREATE failure', async () => {
  const queries = [];
  let closed = false;
  const admin = {
    async connect() {},
    async query(sql) {
      queries.push(sql);
      throw Error('injected create failure');
    },
    async end() {
      closed = true;
    },
  };
  await assert.rejects(
    withTestControl(() => assert.fail('must not run'), { admin }),
    /injected create failure/,
  );
  assert.equal(queries.length, 1);
  assert.equal(closed, true);
});
