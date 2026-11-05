import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vite-plus/test';
import { validateCasimirMigrationBatch } from '../../../deploy-core/src/casimir-migrations.ts';
import * as migrations from '../../src/casimir/migrations.ts';
const file = (name: string, sql: string) => ({
  name,
  sql,
  sha256: createHash('sha256').update(sql).digest('hex'),
});
it('read-only state observation never creates a missing live database', () => {
  const root = mkdtempSync('/tmp/casimir-mvp-a-readonly-');
  try {
    expect(() =>
      migrations.readCasimirMigrationState(join(root, 'missing.sqlite'), true),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('includes ordinary names beginning sqlitex in the bound schema', () => {
  const root = mkdtempSync('/tmp/casimir-mvp-a-schema-'),
    path = join(root, 'app.sqlite');
  try {
    const db = new Database(path);
    db.exec('CREATE TABLE sqlitex_records(id INTEGER)');
    db.close();
    expect(migrations.readCasimirMigrationState(path).schema.tables.sqlitex_records).toEqual([
      'id',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('commits one hashed batch, backs up live SQLite and recognizes replay after lost acknowledgement', async () => {
  const root = mkdtempSync('/tmp/casimir-mvp-a-migrations-'),
    path = join(root, 'app.sqlite');
  try {
    const files = [
      file('0001.sql', 'CREATE TABLE messages (id INTEGER PRIMARY KEY,text TEXT NOT NULL);'),
    ];
    const state = migrations.readCasimirMigrationState(path);
    const plan = await validateCasimirMigrationBatch(files, state.history, state.schema);
    const result = await migrations.applyCasimirMigrationBatch(path, plan);
    expect(result.applied).toEqual(files.map(({ name, sha256 }) => ({ name, sha256 })));
    const db = new Database(path);
    db.prepare('INSERT INTO messages VALUES(?,?)').run(1, 'sentinel');
    await migrations.backupCasimirDatabase(path, join(root, 'snapshot.sqlite'));
    db.prepare('INSERT INTO messages VALUES(?,?)').run(2, 'after snapshot');
    db.close();
    const snapshot = new Database(join(root, 'snapshot.sqlite'));
    expect(snapshot.prepare('SELECT text FROM messages').all()).toEqual([{ text: 'sentinel' }]);
    snapshot.close();
    expect(await migrations.applyCasimirMigrationBatch(path, plan)).toEqual(result);
    await expect(
      migrations.applyCasimirMigrationBatch(path, {
        ...plan,
        files: [{ ...files[0], sql: 'DROP TABLE messages;' }],
      }),
    ).rejects.toThrow(/plan/);
    await expect(
      migrations.applyCasimirMigrationBatch(path, {
        ...plan,
        files: [file('0001.sql', 'CREATE TABLE changed (id INTEGER);')],
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rolls back every file and history on a later SQLite failure; rejects schema changes since planning', async () => {
  const root = mkdtempSync('/tmp/casimir-mvp-a-atomic-'),
    path = join(root, 'app.sqlite');
  try {
    const files = [
      file('0001.sql', 'CREATE TABLE first (id INTEGER);'),
      file('0002.sql', "CREATE TABLE second (created_at TEXT DEFAULT datetime('now'));"),
    ];
    let state = migrations.readCasimirMigrationState(path);
    const plan = await validateCasimirMigrationBatch(files, state.history, state.schema);
    await expect(migrations.applyCasimirMigrationBatch(path, plan)).rejects.toThrow();
    state = migrations.readCasimirMigrationState(path);
    expect(state.history).toEqual([]);
    expect(state.schema.tables.first).toBeUndefined();
    const valid = await validateCasimirMigrationBatch([files[0]], state.history, state.schema);
    const db = new Database(path);
    db.exec('CREATE TABLE foreign_change (id INTEGER)');
    db.close();
    await expect(migrations.applyCasimirMigrationBatch(path, valid)).rejects.toThrow(/changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
