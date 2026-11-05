import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Client } = require('pg');
export const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) {
    return `[${v.map(canonical).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
export function artifact() {
  const content = [
    randomBytes(32768),
    Buffer.from('export default {fetch:()=>new Response("ok")}'),
  ];
  const files = ['dist/client/blob.bin', 'dist/ssr/app.js'].map((path, i) => ({
    path,
    size: content[i].length,
    sha256: sha(content[i]),
  }));
  const manifest = {
    ...runtime,
    entry: 'dist/ssr/app.js',
    files,
    migrations: [],
    envKeys: [],
    compatibilityEntry: null,
  };
  const json = Buffer.from(canonical(manifest)),
    size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  const bytes = gzipSync(Buffer.concat([Buffer.from('CASIMIR1\n'), size, json, ...content]));
  return { bytes, sha256: sha(bytes), manifest };
}
export async function withMvpControl(run, { installationId } = {}) {
  const name = 'casimir_mvp_a_test_' + randomBytes(6).toString('hex');
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  const dir = mkdtempSync(join(tmpdir(), 'casimir-mvp-a-http-'));
  let api,
    db,
    created = false;
  try {
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (existing.rowCount) throw new Error('fixture_database_collision_no_reuse');
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    console.log('Created owned synthetic database ' + name + ' (absent-before-create)');
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + name;
    const profile = join(dir, 'profile.json');
    if (installationId) mkdirSync(join(dir, 'artifacts'), { recursive: true, mode: 0o700 });
    writeFileSync(
      profile,
      JSON.stringify({
        runtime,
        artifactRoot: join(dir, 'artifacts'),
        ...(installationId
          ? {
              installationId,
              origins: { control: 'http://127.0.0.1:4289', app: 'http://127.0.0.1:4290' },
            }
          : {}),
      }),
    );
    const env = {
      ...process.env,
      DATABASE_URL: url.href,
      CASIMIR_OPERATOR_ID: 'casimir_test_operator',
      CASIMIR_TOKEN: process.env.CASIMIR_TOKEN ?? randomBytes(32).toString('hex'),
      PORT: '4289',
      CASIMIR_MVP_PROFILE: profile,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.CASIMIR_EXECUTION_PROFILE;
    for (const script of ['casimir/migrate.mjs', 'casimir/mvp-a/migrate.mjs', 'casimir/seed.mjs']) {
      if (!existsSync(script)) {
        continue;
      }
      const result = spawnSync(process.execPath, [script], {
        env,
        encoding: 'utf8',
        timeout: 60000,
      });
      if (result.status !== 0) {
        throw new Error('fixture migration failed: ' + script + ': ' + result.stderr);
      }
    }
    db = new Client({ connectionString: url.href });
    await db.connect();
    const base = 'http://127.0.0.1:4289';
    let logs = '';
    const stop = async () => {
      if (api && api.exitCode === null) {
        api.kill('SIGTERM');
        await new Promise((r) => api.once('exit', r));
      }
    };
    const start = async () => {
      api = spawn(process.execPath, ['casimir/dist/main.mjs'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      api.stdout.on('data', (x) => (logs += x));
      api.stderr.on('data', (x) => (logs += x));
      for (let i = 0; i < 100; i++) {
        if (api.exitCode !== null) {
          throw new Error('API exited: ' + logs);
        }
        try {
          if ((await fetch(base + '/health')).status === 200) {
            return;
          }
        } catch {
          /* Poll until the fixture's actual listener is ready. */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('API not ready: ' + logs);
    };
    const request = async (path, body, key, options = {}) => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + env.CASIMIR_TOKEN,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = { error: text };
      }
      return { status: response.status, body: value };
    };
    await start();
    try {
      await run({
        db,
        request,
        base,
        env,
        dir,
        artifactRoot: join(dir, 'artifacts'),
        stop,
        isRunning: () => api?.exitCode === null,
        restart: async () => {
          await stop();
          await start();
        },
      });
    } finally {
      await stop();
    }
  } finally {
    if (db) {
      await db.end();
    }
    if (created) {
      await admin.query('DROP DATABASE "' + name + '"');
      console.log('Dropped owned disposable database ' + name);
    }
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
}
