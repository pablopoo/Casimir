import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vite-plus/test';
import { readConfig } from '../../src/config.ts';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import { nodeTargetPlugin } from '../../src/plugin-node-target.ts';
import { withRuntimeEnv, getRuntimeEnv } from '../../src/runtime/env.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];
it('filters internal keys from a frozen startup env without proxy invariant errors', () => {
  withRuntimeEnv(Object.freeze({ __VOID_PRIVATE: 'internal', SERVER_ONLY: 'value' }), () => {
    const env = getRuntimeEnv();
    expect(Object.hasOwn(env, '__VOID_PRIVATE')).toBe(false);
    expect('__VOID_PRIVATE' in env).toBe(false);
    expect(env.__VOID_PRIVATE).toBeUndefined();
    expect(Object.keys(env)).toEqual(['SERVER_ONLY']);
    expect(env.SERVER_ONLY).toBe('value');
  });
});
function fixture(config: unknown) {
  const root = mkdtempSync(join(import.meta.dirname, '.casimir-'));
  roots.push(root);
  writeFileSync(join(root, 'void.json'), JSON.stringify(config));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('permits only native DB and env imports in the opted-in Node guard', () => {
  const root = fixture({});
  const factory = nodeTargetPlugin as (
    target: 'node',
    options?: {
      casimirProfile?: 'node-sqlite-v1';
    },
  ) => ReturnType<typeof nodeTargetPlugin>;
  const native = factory('node', { casimirProfile: 'node-sqlite-v1' });
  const resolve = getHookHandler(native[0].resolveId) as (id: string) => unknown;
  const context = { environment: { config: { root } } };
  expect(() => resolve.call(context, 'void/db')).not.toThrow();
  expect(() => resolve.call(context, 'void/env')).not.toThrow();
  expect(() => resolve.call(context, 'void/kv')).toThrow(/not available/);
  const ordinary = getHookHandler(factory('node')[0].resolveId) as (id: string) => unknown;
  expect(() => ordinary.call(context, 'void/db')).toThrow(/not available/);
});

it('rejects the native profile unless the runtime is explicitly Node', () => {
  for (const target of [undefined, 'cloudflare', 'bun', 'deno']) {
    const root = fixture({ target, casimir: { profile: 'node-sqlite-v1' } });
    expect(() => readConfig(root)).toThrow(/casimir.*node/i);
  }
});

it('rejects unknown native profiles and incompatible database configuration', () => {
  for (const config of [
    { target: 'node', casimir: { profile: 'future' } },
    { target: 'node', casimir: { profile: 'node-sqlite-v1', mount: '/etc' } },
    { target: 'node', casimir: { profile: 'node-sqlite-v1' }, database: 'pg' },
    { target: 'node', casimir: { profile: 'node-sqlite-v1' }, remote: true },
  ]) {
    expect(() => readConfig(fixture(config))).toThrow(/casimir/i);
  }
});

it('executes awaited schema-aware CRUD through the native virtual database', async () => {
  const root = fixture({ target: 'node', casimir: { profile: 'node-sqlite-v1' } });
  mkdirSync(join(root, 'db'));
  writeFileSync(
    join(root, 'db/schema.ts'),
    `
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }), text: text('text').notNull(),
});
`,
  );
  const options = { forceVirtualDb: true, casimirProfile: 'node-sqlite-v1' as const };
  const plugin = drizzlePlugin(root, false, 'sqlite', options);
  const load = getHookHandler(plugin.load) as (id: string) => string;
  const code = load.call({}, '\0virtual:void-db');
  const modulePath = join(root, 'database.mjs');
  writeFileSync(modulePath, code);
  const path = join(root, 'app.sqlite');
  const { openSqliteDatabase } = await import('../../src/migrations/runner.ts');
  const sqlite = await openSqliteDatabase(path);
  sqlite.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)');
  sqlite.close();
  const { messages } = await import(pathToFileURL(join(root, 'db/schema.ts')).href);
  await withRuntimeEnv({ CASIMIR_SQLITE_PATH: path }, async () => {
    const { db, eq } = await import(pathToFileURL(modulePath).href);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.insert(messages).values({ text: 'café 👀' }).returning()).toEqual([
      { id: 1, text: 'café 👀' },
    ]);
    expect(
      await db.update(messages).set({ text: 'v2' }).where(eq(messages.id, 1)).returning(),
    ).toEqual([{ id: 1, text: 'v2' }]);
    expect(await db.delete(messages).where(eq(messages.id, 1)).returning()).toEqual([
      { id: 1, text: 'v2' },
    ]);
    expect(await db.select().from(messages)).toEqual([]);
  });
});
