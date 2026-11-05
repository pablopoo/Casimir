import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withOperatorSuspension } from './operator-state.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const run = (script, extra = {}) =>
  spawnSync(process.execPath, [script], {
    env: { ...process.env, ...extra },
    encoding: 'utf8',
    timeout: 30000,
  });

test('complete migrations fail closed and initialization preserves operator changes', async () => {
  const migration = run('casimir/migrate.mjs');
  assert.equal(migration.status, 0, 'migration runner must exist and apply the full journal');
  const seed = run('casimir/seed.mjs');
  assert.equal(seed.status, 0, 'operator seeding must succeed');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const journal = JSON.parse(
      readFileSync('platform/packages/api/drizzle/meta/_journal.json', 'utf8'),
    );
    const count = await client.query(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    );
    assert.equal(count.rows[0].count, journal.entries.length);
    assert.ok((await client.query('SELECT gen_random_uuid() AS id')).rows[0].id);
    for (const table of ['users', 'projects', 'project_ownership_periods', 'deployments']) {
      assert.equal(
        (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name,
        table,
      );
    }
    await withOperatorSuspension(
      client,
      process.env.CASIMIR_OPERATOR_ID,
      'test_admin_suspend',
      async () => {
        assert.equal(run('casimir/migrate.mjs').status, 0);
        assert.equal(run('casimir/seed.mjs').status, 0);
        assert.equal(
          (
            await client.query('SELECT suspended_reason FROM users WHERE id=$1', [
              process.env.CASIMIR_OPERATOR_ID,
            ])
          ).rows[0].suspended_reason,
          'test_admin_suspend',
        );
        if (process.env.CASIMIR_TEST_FAIL_AFTER_SUSPENSION === '1')
          assert.fail('injected verification failure');
      },
    );
  } finally {
    await client.end();
  }
  const dir = mkdtempSync(join(tmpdir(), 'casimir-migration-fail-'));
  try {
    mkdirSync(join(dir, 'meta'));
    writeFileSync(
      join(dir, 'meta/_journal.json'),
      JSON.stringify({
        entries: [{ idx: 0, when: Date.now() + 100000, tag: '0000_invalid', breakpoints: true }],
      }),
    );
    writeFileSync(join(dir, '0000_invalid.sql'), 'THIS IS INVALID SQL;');
    assert.notEqual(run('casimir/migrate.mjs', { CASIMIR_MIGRATIONS_DIR: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
