import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path/posix';
const root = resolve('.local/mvp-a/consumer'),
  app = 'http://casimir-mvp-a-app-ingress:8080';
const { Client } = createRequire(
  new URL('../../platform/packages/api/package.json', import.meta.url),
)('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function runCli(expectFailure = false) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['casimir/mvp-a/check-cli.mjs', 'update'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let text = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 660000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        text += chunk;
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
  if (expectFailure) {
    assert.notEqual(output.code, 0);
    assert.match(output.text, /casimir_deployment_failed/);
  } else {
    assert.equal(output.code, 0, output.text);
  }
  const retry = await json(join(root, '.void/casimir.retry.json'));
  assert.equal(retry.finished, true);
  const op = (
    await db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [
      retry.receipt.operationId,
    ])
  ).rows[0];
  assert.equal(op.phase, expectFailure ? 'failed' : 'succeeded');
  console.log(
    JSON.stringify({
      operationId: op.id,
      phase: op.phase,
      outcome: op.outcome,
      artifactId: op.artifact_id,
      deploymentId: op.deployment_id,
      imageId: op.image_id,
    }),
  );
  return op;
}
const version = async (value) =>
  writeFile(
    join(root, 'routes/api/version.ts'),
    `import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:${JSON.stringify(value)}}));\n`,
  );
async function state() {
  const response = await fetch(app + '/api/migration-state');
  assert.equal(response.status, 200);
  return response.json();
}
async function stillServing(expected, history) {
  const response = await fetch(app + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-casimir-deployment'), expected.deployment_id);
  assert.equal(response.headers.get('x-casimir-image'), expected.image_id);
  assert.deepEqual((await state()).migrations, history);
  const rows = await (await fetch(app + '/api/messages')).json();
  assert.ok(rows.messages.some((row) => row.text === 'casimir v1 sentinel café 👀'));
  assert.ok(
    (await (await fetch(app + '/api/tags')).json()).rows.some(
      (row) => row.label === 'tag sentinel',
    ),
  );
}
try {
  const base = await json('.local/mvp-a/cli-state.json');
  const original = (
    await db.query('SELECT * FROM casimir_mvp_a.operations WHERE id=$1', [base.operationId])
  ).rows[0];
  assert.equal(original.phase, 'succeeded');
  const oldHistory = original.previous_target.plan.files.map(({ name, sha256 }) => ({
    name,
    sha256,
  }));
  const names = await readdir(join(root, 'db/migrations'));
  const index = 1 + Math.max(0, ...names.map((name) => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
  const number = String(index).padStart(4, '0'),
    table = 'tags_' + number,
    migration = number + '_tags.sql';
  await writeFile(
    join(root, 'db/migrations', migration),
    `CREATE TABLE ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL);\nCREATE INDEX ${table}_label ON ${table}(label);\n`,
  );
  const schemaPath = join(root, 'db/schema.ts'),
    schema = (await readFile(schemaPath, 'utf8')).replace(/^export const tags=.*\n?/m, '');
  await writeFile(
    schemaPath,
    schema +
      `\nexport const tags=sqliteTable(${JSON.stringify(table)},{id:integer('id').primaryKey({autoIncrement:true}),label:text('label').notNull()});\n`,
  );
  await writeFile(
    join(root, 'routes/api/tags.ts'),
    `import {tags} from '@schema';import {defineHandler} from 'void';import {db} from 'void/db';import {createInsertSchema} from 'void/drizzle-zod';export const GET=defineHandler(async()=>({rows:await db.select().from(tags)}));export const POST=defineHandler.withValidator({body:createInsertSchema(tags).pick({label:true})})(async(_c,{body})=>({rows:await db.insert(tags).values(body).returning()}));\n`,
  );
  await writeFile(
    join(root, 'routes/api/migration-state.ts'),
    `import {defineHandler} from 'void';import {db,sql} from 'void/db';export const GET=defineHandler(()=>({migrations:db.all(sql\`SELECT name,sha256 FROM __casimir_migrations ORDER BY name\`),tables:db.all(sql\`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\`)}));\n`,
  );
  await version('v3');
  const additive = await runCli();
  assert.notEqual(additive.image_id, original.image_id);
  assert.ok(additive.compatibility_proof);
  assert.equal(additive.compatibility_proof.passed, true);
  assert.equal(
    additive.compatibility_proof.schemaDigest,
    additive.previous_target.result.schemaDigest,
  );
  assert.equal(
    additive.compatibility_proof.artifactHash,
    (
      await db.query('SELECT sha256 FROM casimir_mvp_a.artifacts WHERE id=$1', [
        original.artifact_id,
      ])
    ).rows[0].sha256,
  );
  const response = await fetch(app + '/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'tag sentinel' }),
  });
  assert.equal(response.status, 200);
  const observed = await state();
  assert.equal(observed.migrations.length, oldHistory.length + 1);
  assert.deepEqual(observed.migrations.slice(0, oldHistory.length), oldHistory);
  assert.ok(observed.tables.some((row) => row.name === table));
  await stillServing(additive, observed.migrations);
  console.log('Additive migration and retained old-release CRUD proof pass');
  const unsafe = join(root, 'db/migrations', String(index + 1).padStart(4, '0') + '_unsafe.sql');
  await writeFile(unsafe, 'DROP TABLE messages;\n');
  await version('unsafe');
  try {
    const rejected = await runCli(true);
    assert.equal(rejected.exposure_started, null);
    assert.equal(rejected.snapshot_fingerprint, null);
    await stillServing(additive, observed.migrations);
  } finally {
    await unlink(unsafe);
  }
  const first = join(root, 'db/migrations', oldHistory[0].name),
    old = await readFile(first);
  await writeFile(first, Buffer.concat([old, Buffer.from('\n-- edited history validation\n')]));
  await version('edited-history');
  try {
    const rejected = await runCli(true);
    assert.equal(rejected.exposure_started, null);
    assert.equal(rejected.snapshot_fingerprint, null);
    await stillServing(additive, observed.migrations);
  } finally {
    await writeFile(first, old);
  }
  const loaderPath = join(root, 'pages/index.server.ts'),
    loader = await readFile(loaderPath, 'utf8');
  const needle =
    'export const loader = defineHandler(async () => ({\n  messages: await db.select().from(messages).orderBy(desc(messages.id)),\n}));';
  assert.ok(loader.includes(needle));
  await writeFile(
    loaderPath,
    loader.replace(
      needle,
      "export const loader=defineHandler(async()=>{const rows=await db.select().from(messages).orderBy(desc(messages.id));if(rows.length>=0){throw new Error('casimir_test_candidate_failure');}return {messages:rows};});",
    ),
  );
  await version('broken');
  try {
    const rejected = await runCli(true);
    assert.equal(rejected.exposure_started, null);
    assert.equal(rejected.outcome, 'restored');
    assert.ok(rejected.snapshot_fingerprint);
    await stillServing(additive, observed.migrations);
  } finally {
    await writeFile(loaderPath, loader);
    await version('v3');
  }
  await writeFile(
    '.local/mvp-a/flow-state.json',
    JSON.stringify({
      operationId: additive.id,
      projectId: additive.project_id,
      deploymentId: additive.deployment_id,
      artifactId: additive.artifact_id,
      imageId: additive.image_id,
      migrations: observed.migrations,
    }),
  );
  console.log(
    'Real additive/unsafe/edited-history/unhealthy-candidate flow passes with sentinel data intact',
  );
} finally {
  await db.end();
}
