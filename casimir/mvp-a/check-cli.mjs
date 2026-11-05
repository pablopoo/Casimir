import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, readdir, stat, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path/posix';
const source = process.cwd(),
  root = resolve('.local/mvp-a/consumer'),
  archives = resolve('.local/mvp-a/sdk');
const mode = process.argv[2] ?? 'first';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
function run(command, args, cwd = source, env = process.env) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 660000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
        if (output.length > 12 * 1024 * 1024) {
          child.kill('SIGTERM');
        }
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command ${command} ${args.join(' ')} failed (${code})\n${output}`));
      }
    });
  });
}
await mkdir(root, { recursive: true });
if (mode === 'first') {
  await run(process.execPath, ['casimir/mvp-a/pack-sdk.mjs', archives]);
  const catalog = await readJson(join(archives, 'catalog.json'));
  const overrides = Object.fromEntries(
    Object.entries(catalog).map(([name, value]) => [
      name,
      'file:' + join(archives, value.filename),
    ]),
  );
  await cp('casimir/examples/notes', root, { recursive: true });
  // This ignored validation consumer is disposable; persistent server data is not.
  // Reconstruct its already-applied SQL from the actual serving release journal.
  // Production CLI code never edits a user's migrations this way.
  const { Client } = createRequire(
    new URL('../../platform/packages/api/package.json', import.meta.url),
  )('pg');
  const fixtureDb = new Client({ connectionString: process.env.DATABASE_URL });
  await fixtureDb.connect();
  try {
    const current = await fixtureDb.query(
      "SELECT o.previous_target FROM casimir_mvp_a.operations o JOIN projects p ON p.active_deployment_id=o.deployment_id WHERE p.slug='mvp-notes' AND o.phase='succeeded'",
    );
    if (current.rows.length) {
      assert.equal(current.rows.length, 1);
      const files = current.rows[0].previous_target.plan.files;
      await rm(join(root, 'db/migrations'), { recursive: true, force: true });
      await mkdir(join(root, 'db/migrations'));
      for (const file of files) {
        assert.match(file.name, /^\d+_[a-zA-Z0-9_-]+\.sql$/);
        await writeFile(join(root, 'db/migrations', file.name), file.sql);
      }
    }
  } finally {
    await fixtureDb.end();
  }
  for (const path of ['routes/api/tags.ts', 'routes/api/migration-state.ts']) {
    await rm(join(root, path), { force: true });
  }
  const version = async (name) =>
    (await readJson(join(source, 'playground/node-app/node_modules', name, 'package.json')))
      .version;
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'casimir-installed-cli-notes',
      private: true,
      type: 'module',
      dependencies: {
        void: overrides.void,
        '@void/react': overrides['@void/react'],
        '@void/deploy-core': overrides['@void/deploy-core'],
        '@hono/node-server': await version('@hono/node-server'),
        react: await version('react'),
        'react-dom': await version('react-dom'),
        'better-sqlite3': (await readJson('packages/void/node_modules/better-sqlite3/package.json'))
          .version,
      },
      devDependencies: { vite: 'npm:@voidzero-dev/vite-plus-core@1.2.0', 'vite-plus': '1.2.0' },
    }),
  );
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    [
      'packages: []',
      'allowBuilds:',
      '  better-sqlite3: true',
      'overrides:',
      ...Object.entries(overrides).map(
        ([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value),
      ),
      '',
    ].join('\n'),
  );
  await writeFile(join(root, '.env'), 'SERVER_ONLY=casimir-build-placeholder\n');
  await writeFile(
    join(root, 'routes/api/version.ts'),
    "import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:'v1'}));\n",
  );
  await run(
    'pnpm',
    [
      'install',
      process.env.CASIMIR_TEST_OFFLINE === '1' ? '--offline' : '--prefer-offline',
      '--ignore-scripts',
    ],
    root,
  );
  await run('pnpm', ['rebuild', 'better-sqlite3'], root);
}
let dropAdmission = mode === 'retry',
  uploads = 0;
const admissionKeys = [];
if (mode === 'retry') {
  await writeFile(
    join(root, 'routes/api/version.ts'),
    "import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:'v2'}));\n",
  );
}
const proxy = createServer((incoming, outgoing) => {
  if (incoming.method === 'POST' && incoming.url.endsWith('/uploads')) {
    uploads++;
  }
  if (incoming.method === 'POST' && incoming.url.endsWith('/deployments')) {
    admissionKeys.push(incoming.headers['idempotency-key']);
  }
  const upstream = request(
    {
      hostname: 'casimir-mvp-a-control-ingress',
      port: 8080,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      if (
        dropAdmission &&
        incoming.method === 'POST' &&
        incoming.url.endsWith('/deployments') &&
        response.statusCode === 202
      ) {
        dropAdmission = false;
        response.resume();
        response.on('end', () => outgoing.destroy());
        return;
      }
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(4285, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:4285';
const env = {
  ...process.env,
  CASIMIR_API_URL: origin,
  CASIMIR_CONFIG_DIR: resolve('.local/mvp-a/cli-config'),
};
const cli = join(root, 'node_modules/void/dist/cli/cli.mjs');
try {
  if (mode === 'first') {
    console.log(
      await run(process.execPath, [cli, 'connect', '--platform', 'casimir', origin], root, env),
    );
  }
  if (mode === 'retry') {
    await assert.rejects(
      run(process.execPath, [cli, 'deploy', '--project', 'mvp-notes'], root, env),
    );
    const pending = await readJson(join(root, '.void/casimir.retry.json'));
    assert.equal(pending.finished, false);
    assert.equal(pending.receipt, undefined);
    assert.equal(uploads, 1);
    assert.equal(admissionKeys.length, 1);
  }
  console.log(await run(process.execPath, [cli, 'deploy', '--project', 'mvp-notes'], root, env));
  if (mode === 'retry') {
    assert.equal(uploads, 1);
    assert.equal(admissionKeys.length, 2);
    assert.equal(admissionKeys[0], admissionKeys[1]);
    console.log(
      'Real lost-admission-response retry preserved its artifact/key and performed no second upload',
    );
  }
  const link = await readJson(join(root, '.void/casimir.json')),
    retry = await readJson(join(root, '.void/casimir.retry.json'));
  assert.equal(retry.finished, true);
  assert.equal((await stat(join(root, '.void/casimir.retry.json'))).mode & 0o077, 0);
  const view = await (
    await fetch(
      `${origin}/casimir/v1/projects/${link.projectId}/operations/${retry.receipt.operationId}`,
      { headers: { Authorization: 'Bearer ' + env.CASIMIR_TOKEN } },
    )
  ).json();
  assert.equal(view.phase, 'succeeded');
  assert.equal(view.verifiedServing.artifactId, retry.artifactId);
  const app = 'http://casimir-mvp-a-app-ingress:8080';
  const html = await fetch(app);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('x-casimir-image'), view.verifiedServing.imageId);
  const text = await html.text();
  assert.match(text, /Casimir notes/);
  const asset = text.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/);
  assert.ok(asset);
  assert.equal((await fetch(new URL(asset[1], app))).status, 200);
  assert.equal((await fetch(app + '/_casimir/identity')).status, 404);
  assert.deepEqual(await (await fetch(app + '/api/configured')).json(), { configured: true });
  if (mode === 'retry') {
    assert.deepEqual(await (await fetch(app + '/api/version')).json(), { version: 'v2' });
  }
  if (mode === 'first') {
    const response = await fetch(app + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'casimir v1 sentinel café 👀' }),
    });
    assert.equal(response.status, 200);
  }
  const rows = await (await fetch(app + '/api/messages')).json();
  assert.ok(rows.messages.some((row) => row.text === 'casimir v1 sentinel café 👀'));
  const runtimeEnv = await readJson('.local/mvp-a/runtime-env.json');
  async function scan(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        await scan(path);
      } else {
        const contents = await readFile(path);
        for (const value of Object.values(runtimeEnv)) {
          assert.equal(contents.includes(Buffer.from(value)), false);
        }
      }
    }
  }
  await scan(join(root, 'dist/client'));
  console.log(await run(process.execPath, [cli, 'project', 'status'], root, env));
  await writeFile(
    '.local/mvp-a/cli-state.json',
    JSON.stringify({
      projectId: link.projectId,
      ...view.verifiedServing,
      operationId: retry.receipt.operationId,
    }),
  );
  console.log(
    JSON.stringify({ gate: 'installed-cli-serving', ...view.verifiedServing, sentinel: true }),
  );
} finally {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
}
