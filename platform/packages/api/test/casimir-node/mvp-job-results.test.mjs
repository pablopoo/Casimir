import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
test('fixed-runner plan result is closed, bounded and retains its ordered pending suffix', () => {
  assert.equal(typeof checks.parseMvpPlanResult, 'function');
  const file = {
    name: '0001.sql',
    sql: 'CREATE TABLE messages(id INTEGER);',
    sha256: 'a'.repeat(64),
  };
  const value = {
    files: [file],
    pending: [file],
    priorSchemaDigest: 'b'.repeat(64),
    priorHistoryDigest: 'c'.repeat(64),
    fingerprint: 'd'.repeat(64),
  };
  assert.deepEqual(checks.parseMvpPlanResult(value), value);
  for (const bad of [
    null,
    [],
    { ...value, extra: true },
    { ...value, fingerprint: 'bad' },
    { ...value, pending: [{ ...file, name: 'other.sql' }] },
    { ...value, files: [{ ...file, sql: 42 }] },
  ]) {
    assert.throws(() => checks.parseMvpPlanResult(bad), /job_result/);
  }
});
