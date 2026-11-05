import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../platform/packages/api/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase), 'choose before or after');
const base = process.env.API_BASE_URL ?? 'http://api:4281';
const request = async (path, body) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CASIMIR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  assert.ok(r.ok, `HTTP ${r.status}`);
  return r.json();
};
try {
  await client.connect();
  let project;
  if (phase === 'before') {
    project = await request('/projects', { slug: 'casimir-restart-' + Date.now().toString(36) });
    await request(`/projects/${project.id}/deployments`, {});
    await client.query("UPDATE users SET login='preserved-restart-operator' WHERE id=$1", [
      process.env.CASIMIR_OPERATOR_ID,
    ]);
  } else project = JSON.parse(readFileSync('/results/restart.json', 'utf8')).httpProject;
  const snapshot = {
    httpProject: await request('/projects/' + project.id),
    httpDeployments: await request(`/projects/${project.id}/deployments`),
    project: (await client.query('SELECT * FROM projects WHERE id=$1', [project.id])).rows,
    deployments: (
      await client.query('SELECT * FROM deployments WHERE project_id=$1 ORDER BY id', [project.id])
    ).rows,
    ownership: (
      await client.query(
        'SELECT * FROM project_ownership_periods WHERE project_id=$1 ORDER BY id',
        [project.id],
      )
    ).rows,
    operator: (
      await client.query('SELECT id,login,plan,suspended_reason FROM users WHERE id=$1', [
        process.env.CASIMIR_OPERATOR_ID,
      ])
    ).rows,
  };
  assert.equal(snapshot.httpDeployments.activeDeploymentId, null);
  assert.equal(snapshot.deployments.length, 1);
  assert.equal(snapshot.deployments[0].status, 'pending');
  if (phase === 'before') writeFileSync('/results/restart.json', JSON.stringify(snapshot, null, 2));
  else
    assert.deepEqual(
      JSON.parse(JSON.stringify(snapshot)),
      JSON.parse(readFileSync('/results/restart.json', 'utf8')),
    );
  console.log(`Restart ${phase} verified: ${project.id}, ${snapshot.deployments[0].id}`);
} finally {
  await client.end();
}
