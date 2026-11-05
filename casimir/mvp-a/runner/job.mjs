import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path/posix';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  readCasimirMigrationState,
  readCasimirMigrationFiles,
  applyCasimirMigrationBatch,
  backupCasimirDatabase,
  validateCasimirMigrationBatch,
  getCasimirSchemaDigest,
} from './dist/migrations.mjs';

const job = JSON.parse(await readFile('/run/casimir/job.json', 'utf8'));
if (
  !job ||
  !['state', 'plan', 'apply', 'backup', 'restore', 'compatibility'].includes(job.action)
) {
  throw new Error('job_action');
}
function dataPath(value) {
  if (
    typeof value !== 'string' ||
    !/^\/(data\/app\.sqlite|snapshots\/[a-f0-9]{32}\.sqlite)$/.test(value)
  ) {
    throw new Error('job_path');
  }
  return value;
}
const path = dataPath(job.path);
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
let result;
if (job.action === 'state') {
  result = { ...readCasimirMigrationState(path, true), schemaDigest: getCasimirSchemaDigest(path) };
}
if (job.action === 'plan') {
  const manifest = JSON.parse(await readFile('/app/casimir-manifest.json', 'utf8'));
  const files = await readCasimirMigrationFiles('/app/db/migrations');
  if (
    JSON.stringify(files.map(({ name, sha256 }) => ({ name, sha256 }))) !==
    JSON.stringify(manifest.migrations.map(({ name, sha256 }) => ({ name, sha256 })))
  ) {
    throw new Error('migration_manifest');
  }
  const state = readCasimirMigrationState(path);
  result = await validateCasimirMigrationBatch(files, state.history, state.schema);
}
if (job.action === 'apply') {
  result = { ...(await applyCasimirMigrationBatch(path, job.plan)), sha256: await hashFile(path) };
}
if (job.action === 'backup') {
  await backupCasimirDatabase(path, dataPath(job.destination));
  result = {
    ok: true,
    sha256: await hashFile(job.destination),
    schemaDigest: getCasimirSchemaDigest(job.destination),
  };
}
if (job.action === 'restore') {
  if (!path.startsWith('/snapshots/')) {
    throw new Error('restore_source');
  }
  if ((await hashFile(path)) !== job.expectedSha256) {
    throw new Error('snapshot_changed');
  }
  const source = new Database(path, { readonly: true, fileMustExist: true });
  try {
    await source.backup('/data/app.sqlite');
  } finally {
    source.close();
  }
  result = { ok: true };
}
if (job.action === 'compatibility') {
  if (!path.startsWith('/snapshots/')) {
    throw new Error('compatibility_live_forbidden');
  }
  if (
    (await hashFile(path)) !== job.expectedSha256 ||
    getCasimirSchemaDigest(path) !== job.expectedSchemaDigest
  ) {
    throw new Error('snapshot_changed');
  }
  const manifest = JSON.parse(await readFile('/app/casimir-manifest.json', 'utf8'));
  const hook = manifest.compatibilityEntry;
  if (!hook || !hook.startsWith('compatibility/') || resolve('/app', hook) !== '/app/' + hook) {
    throw new Error('compatibility_missing');
  }
  const { verifyCompatibility } = await import(pathToFileURL('/app/' + hook).href);
  if (typeof verifyCompatibility !== 'function') {
    throw new Error('compatibility_entry');
  }
  const db = new Database(path);
  try {
    await verifyCompatibility({
      db,
      schema: readCasimirMigrationState(path).schema,
      recordId: 'casimir-compatibility-probe',
    });
  } finally {
    db.close();
  }
  result = { ok: true };
}
const output = await open('/output/result.json', 'wx', 0o400);
try {
  await output.writeFile(JSON.stringify(result));
  await output.sync();
} finally {
  await output.close();
}
