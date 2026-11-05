import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
await db.connect();
try {
  const s = JSON.parse(readFileSync('/results/execution-flow.json', 'utf8'));
  const projects = (
    await db.query('SELECT id,user_id,active_deployment_id FROM projects WHERE id=$1', [
      s.projectId,
    ])
  ).rows;
  const operations = (
    await db.query(
      'SELECT id,deployment_id,actor_id,phase,outcome,candidate_id FROM casimir.execution_operations WHERE project_id=$1 ORDER BY id',
      [s.projectId],
    )
  ).rows;
  const served = await (
    await fetch('http://app-ingress:8080/version', { signal: AbortSignal.timeout(3000) })
  ).json();
  const record = await (await fetch('http://app-ingress:8080/records/persisted')).json();
  assert.equal(record.value, 'keep-me');
  assert.equal(served.deploymentId, projects[0].active_deployment_id);
  const snapshot = { projects, operations, served, record };
  if (process.argv[2] === 'capture')
    writeFileSync('/results/execution-restart.json', JSON.stringify(snapshot));
  else
    assert.deepEqual(snapshot, JSON.parse(readFileSync('/results/execution-restart.json', 'utf8')));
  console.log('Persistent control and app snapshot', process.argv[2]);
} finally {
  await db.end();
}
