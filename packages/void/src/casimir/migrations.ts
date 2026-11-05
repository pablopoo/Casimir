import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import {
  canonicalJson,
  validateCasimirMigrationBatch,
  type AppliedMigration,
  type MigrationFile,
  type MigrationPlan,
  type SchemaDescription,
} from '@void/deploy-core';
import Database from 'better-sqlite3';
import { dirname, isAbsolute, join } from 'pathslash';

export type BatchResult = {
  applied: Array<AppliedMigration>;
  schemaDigest: string;
  fingerprint: string;
};
export { validateCasimirMigrationBatch };
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function checkPath(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('migration_path');
  }
}
function state(db: Database.Database): {
  history: Array<AppliedMigration>;
  schema: SchemaDescription;
} {
  const objects = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    )
    .all() as SchemaDescription['objects'];
  const tables: Record<string, Array<string>> = {};
  for (const object of objects.filter((o) => o.type === 'table')) {
    tables[object.name] = (
      db.prepare(`PRAGMA table_info("${object.name.replaceAll('"', '""')}")`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
  }
  const history = objects.some((o) => o.name === '__casimir_migrations')
    ? (db
        .prepare('SELECT name,sha256 FROM __casimir_migrations ORDER BY name')
        .all() as Array<AppliedMigration>)
    : [];
  return { history, schema: { objects, tables } };
}
export function readCasimirMigrationState(
  path: string,
  readOnly: boolean = false,
): {
  history: Array<AppliedMigration>;
  schema: SchemaDescription;
} {
  checkPath(path);
  const db = new Database(path, { readonly: readOnly, fileMustExist: readOnly });
  try {
    return state(db);
  } finally {
    db.close();
  }
}
export function getCasimirSchemaDigest(path: string): string {
  return digest(readCasimirMigrationState(path, true).schema);
}
export async function readCasimirMigrationFiles(directory: string): Promise<Array<MigrationFile>> {
  let names: Array<string>;
  try {
    names = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: Array<MigrationFile> = [];
  for (const name of names) {
    const fd = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
        throw new Error('migration_file');
      }
      const bytes = await fd.readFile();
      const sql = bytes.toString('utf8');
      if (!Buffer.from(sql).equals(bytes)) {
        throw new Error('migration_encoding');
      }
      files.push({ name, sql, sha256: createHash('sha256').update(bytes).digest('hex') });
    } finally {
      await fd.close();
    }
  }
  return files;
}
export async function applyCasimirMigrationBatch(
  path: string,
  plan: MigrationPlan,
): Promise<BatchResult> {
  checkPath(path);
  const { fingerprint, ...input } = plan;
  if (digest(input) !== fingerprint) {
    throw new Error('migration_plan_changed');
  }
  const db = new Database(path);
  db.pragma('foreign_keys=ON');
  try {
    const before = state(db);
    const prior = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__casimir_batches'")
      .get();
    if (prior) {
      const batch = db
        .prepare('SELECT result FROM __casimir_batches WHERE fingerprint=?')
        .get(plan.fingerprint) as { result: string } | undefined;
      if (batch) {
        const result = JSON.parse(batch.result) as BatchResult;
        if (
          canonicalJson(before.history) !== canonicalJson(result.applied) ||
          digest(before.schema) !== result.schemaDigest ||
          canonicalJson(plan.files.map(({ name, sha256 }) => ({ name, sha256 }))) !==
            canonicalJson(result.applied)
        ) {
          throw new Error('migration_changed');
        }
        return result;
      }
    }
    if (
      digest(before.schema) !== plan.priorSchemaDigest ||
      digest(before.history) !== plan.priorHistoryDigest
    ) {
      throw new Error('migration_changed');
    }
    const checked = await validateCasimirMigrationBatch(plan.files, before.history, before.schema);
    if (checked.fingerprint !== plan.fingerprint) {
      throw new Error('migration_plan_changed');
    }
    return db
      .transaction(() => {
        const current = state(db);
        if (
          digest(current.schema) !== plan.priorSchemaDigest ||
          digest(current.history) !== plan.priorHistoryDigest
        ) {
          throw new Error('migration_changed');
        }
        db.exec(
          'CREATE TABLE IF NOT EXISTS __casimir_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS __casimir_batches(fingerprint TEXT PRIMARY KEY,result TEXT NOT NULL);',
        );
        for (const file of checked.pending) {
          db.exec(file.sql);
          db.prepare('INSERT INTO __casimir_migrations(name,sha256) VALUES(?,?)').run(
            file.name,
            file.sha256,
          );
        }
        const after = state(db);
        const result = {
          applied: after.history,
          schemaDigest: digest(after.schema),
          fingerprint: plan.fingerprint,
        };
        db.prepare('INSERT INTO __casimir_batches(fingerprint,result) VALUES(?,?)').run(
          plan.fingerprint,
          JSON.stringify(result),
        );
        return result;
      })
      .immediate();
  } finally {
    db.close();
  }
}
export async function backupCasimirDatabase(path: string, destination: string): Promise<void> {
  checkPath(path);
  checkPath(destination);
  if (
    await lstat(destination).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') {
          return false;
        }
        throw e;
      },
    )
  ) {
    throw new Error('snapshot_exists');
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  const fd = await open(destination, 'r');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dir = await open(dirname(destination), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
