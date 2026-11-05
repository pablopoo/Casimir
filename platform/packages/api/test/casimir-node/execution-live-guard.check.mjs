import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const row = (
    await db.query("SELECT * FROM casimir.executor_guard WHERE scope='casimir-execution-poc'")
  ).rows[0];
  assert.ok(row);
  if (process.argv[2] === 'capture')
    writeFileSync('/results/execution-live-guard.json', JSON.stringify(row));
  else if (process.argv[2] === 'terminate') {
    writeFileSync('/results/execution-live-guard.json', JSON.stringify(row));
    const locks = await db.query(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1128354643 AND objid=1 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    );
    assert.equal(locks.rowCount, 1);
    await db.query('SELECT pg_terminate_backend($1)', [locks.rows[0].pid]);
  } else {
    const prior = JSON.parse(readFileSync('/results/execution-live-guard.json', 'utf8'));
    if (process.argv[2] === 'unchanged') assert.equal(row.instance, prior.instance);
    else if (process.argv[2] === 'replaced') assert.notEqual(row.instance, prior.instance);
    else throw Error('invalid stage');
  }
  console.log('Real executor guard', process.argv[2]);
} finally {
  await db.end();
}
