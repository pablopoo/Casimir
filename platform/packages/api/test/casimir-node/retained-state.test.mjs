import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');

test('persistence verification preserves pre-existing suspension on success and assertion failure', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const id = 'casimir_retained_' + Date.now().toString(36),
    reason = 'pre_existing_operator_suspension';
  try {
    await client.query(
      "INSERT INTO users (id,provider,provider_id,login,suspended_reason) VALUES ($1,'casimir-test',$1,'fictional-retained',$2)",
      [id, reason],
    );
    for (const fail of [false, true]) {
      const childEnv = {
        ...process.env,
        CASIMIR_OPERATOR_ID: id,
        CASIMIR_TEST_FAIL_AFTER_SUSPENSION: fail ? '1' : '',
      };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawnSync(
        process.execPath,
        ['--test', 'platform/packages/api/test/casimir-node/persistence.test.mjs'],
        {
          env: childEnv,
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      assert.equal(
        (await client.query('SELECT suspended_reason FROM users WHERE id=$1', [id])).rows[0]
          .suspended_reason,
        reason,
        'verification must restore the exact original suspension',
      );
      if (fail) assert.equal(child.status, 1, 'injected assertion must actually fail');
      else assert.equal(child.status, 0, 'ordinary verification must pass');
    }
  } finally {
    await client.end();
  }
});
