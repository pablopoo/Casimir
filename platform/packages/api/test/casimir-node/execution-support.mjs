import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
export const catalog = {
  recipeVersion: 1,
  scope: 'casimir-execution-poc',
  controlPort: 4283,
  appPort: 4284,
  images: {
    'demo-v1': 'sha256:' + '1'.repeat(64),
    'demo-v2': 'sha256:' + '2'.repeat(64),
    'demo-broken': 'sha256:' + '3'.repeat(64),
  },
};
export async function withTestControl(run, options = {}) {
  const name = options.name ?? 'casimir_execution_test_' + randomBytes(6).toString('hex');
  if (!/^casimir_execution_test_[a-z0-9]{12}$/.test(name)) throw new Error('invalid fixture name');
  const admin = options.admin ?? new Client({ connectionString: process.env.DATABASE_URL });
  const dir = mkdtempSync(join(tmpdir(), 'casimir-execution-test-'));
  let api,
    db,
    created = false;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + name;
    const env = {
      ...process.env,
      DATABASE_URL: url.href,
      CASIMIR_OPERATOR_ID: 'casimir_test_operator',
      PORT: '4289',
    };
    delete env.NODE_TEST_CONTEXT;
    const file = join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(catalog));
    env.CASIMIR_EXECUTION_PROFILE = file;
    for (const script of [
      'casimir/migrate.mjs',
      'casimir/migrate-execution.mjs',
      'casimir/seed.mjs',
    ]) {
      if (!existsSync(script)) continue;
      const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0)
        throw new Error('fixture initialization failed: ' + script + ': ' + r.stderr);
    }
    db = new Client({ connectionString: url.href });
    await db.connect();
    api = spawn(process.execPath, ['casimir/dist/main.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    api.stdout.on('data', (x) => (logs += x));
    api.stderr.on('data', (x) => (logs += x));
    const baseUrl = 'http://127.0.0.1:4289';
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (api.exitCode !== null) throw new Error('test API exited: ' + logs);
      try {
        if ((await fetch(baseUrl + '/health')).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) throw new Error('fixture API did not become ready: ' + logs);
    const request = async (path, body, key) => {
      const response = await fetch(baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + env.CASIMIR_TOKEN,
          'Content-Type': 'application/json',
          ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
      return { status: response.status, body: parsed };
    };
    await run({ db, request, baseUrl, catalog, env });
  } finally {
    try {
      try {
        if (api && api.exitCode === null) {
          api.kill('SIGTERM');
          await new Promise((r) => api.once('exit', r));
        }
      } finally {
        if (db) await db.end();
      }
    } finally {
      try {
        if (created) {
          await admin.query('DROP DATABASE "' + name + '"');
          console.log('Dropped owned disposable test database ' + name);
        }
      } finally {
        try {
          await admin.end();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }
}
export async function projectAndDeployment(request, slug) {
  const project = await request('/projects', { slug });
  if (project.status !== 201) throw new Error('project fixture failed: ' + project.status);
  const deployment = await request('/projects/' + project.body.id + '/deployments', {});
  if (deployment.status !== 201) throw new Error('deployment fixture failed');
  return { project: project.body, deployment: deployment.body };
}
