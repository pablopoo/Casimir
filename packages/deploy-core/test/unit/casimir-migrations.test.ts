import { describe, expect, it } from 'vite-plus/test';
import * as migrations from '../../src/casimir-migrations.ts';
const hash = async (sql: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const file = async (sql: string, name = '0001.sql') => ({ name, sql, sha256: await hash(sql) });
const schema = { objects: [], tables: {} };
describe('bounded native migrations', () => {
  it('accepts parsed new tables/indexes including literal SQL keywords', async () => {
    const sql =
      "CREATE TABLE `messages` (id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT NOT NULL DEFAULT 'DROP TABLE x; --',created_at TEXT DEFAULT (datetime('now'))); /* ok */ CREATE INDEX messages_text ON messages (text);";
    const plan = await migrations.validateCasimirMigrationBatch([await file(sql)], [], schema);
    expect(plan.pending).toHaveLength(1);
    expect(plan.priorSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects unsupported grammar, unclosed lexical regions and unparsed suffixes', async () => {
    for (const sql of [
      'DROP TABLE messages;',
      'ALTER TABLE messages ADD COLUMN x TEXT;',
      'PRAGMA journal_mode=WAL;',
      "ATTACH DATABASE ':memory:' AS x;",
      'CREATE TEMP TABLE x (id INTEGER);',
      'CREATE VIRTUAL TABLE x USING fts5(text);',
      'CREATE TABLE x AS SELECT 1;',
      'CREATE TABLE x (id INTEGER UNIQUE);',
      'CREATE UNIQUE INDEX x ON messages(text);',
      'CREATE TRIGGER x AFTER INSERT ON messages BEGIN SELECT 1; END;',
      "CREATE TABLE x (v TEXT DEFAULT 'broken);",
      'CREATE TABLE x (v TEXT); /* broken',
      'CREATE TABLE x (v TEXT); /*/',
      "CREATE TABLE x (v TEXT DEFAULT 'a'');",
      'CREATE TABLE "broken (id INTEGER);',
      'CREATE TABLE x (v TEXT) STRICT;',
      'CREATE TABLE x (v TEXT); SELECT 1;',
      'CREATE TABLE __casimir_migrations (id INTEGER);',
      'CREATE TABLE x (v TEXT REFERENCES y(id));',
      'CREATE TABLE x (id INTEGER PRIMARY KEY DESC);',
      'CREATE TABLE x (v TEXT DEFAULT (random()));',
      'CREATE INDEX x ON missing(v);',
    ]) {
      await expect(
        migrations.validateCasimirMigrationBatch([await file(sql)], [], schema),
        sql,
      ).rejects.toThrow();
    }
  });
  it('binds history content/order and disallows existing table/index collisions', async () => {
    const first = await file('CREATE TABLE messages (id INTEGER PRIMARY KEY);');
    await expect(
      migrations.validateCasimirMigrationBatch([{ ...first, sha256: 'a'.repeat(64) }], [], schema),
    ).rejects.toThrow(/hash/);
    await expect(
      migrations.validateCasimirMigrationBatch(
        [first],
        [{ name: first.name, sha256: 'b'.repeat(64) }],
        schema,
      ),
    ).rejects.toThrow(/history/);
    await expect(
      migrations.validateCasimirMigrationBatch(
        [],
        [{ name: first.name, sha256: first.sha256 }],
        schema,
      ),
    ).rejects.toThrow(/history/);
    await expect(
      migrations.validateCasimirMigrationBatch([first], [], {
        objects: [],
        tables: { messages: ['id'] },
      }),
    ).rejects.toThrow(/exists/);
  });
});
