import { expect, it } from 'vite-plus/test';
import {
  CASIMIR_LIMITS,
  parseCasimirManifest,
  parseRuntimeDescriptor,
  assertCasimirRuntime,
} from '../../src/casimir.ts';
const hash = 'a'.repeat(64);
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: hash,
  platform: 'linux/amd64',
  nodeAbi: '137',
} as const;
function manifest() {
  return {
    ...runtime,
    entry: 'dist/ssr/app.js',
    files: [{ path: 'dist/ssr/app.js', size: 1, sha256: hash }],
    migrations: [],
    envKeys: ['SERVER_ONLY'],
    compatibilityEntry: null,
  };
}
it('parses a closed native manifest and exact runtime descriptor', () => {
  expect(parseCasimirManifest(manifest())).toEqual(manifest());
  expect(parseRuntimeDescriptor(runtime)).toEqual(runtime);
  expect(() => parseCasimirManifest({ ...manifest(), secret: 'bad' })).toThrow('manifest_keys');
  for (const key of Object.keys(runtime)) {
    expect(() =>
      assertCasimirRuntime(manifest(), { ...runtime, [key]: 'wrong' } as never),
    ).toThrow();
  }
});
it('rejects nonportable paths, duplicates, credentials and forged metadata', () => {
  for (const path of [
    '/dist/a',
    'dist/../a',
    'dist/ssr/./a',
    'dist\\ssr\\a',
    'dist/ssr/.env',
    'dist/ssr/node_modules/a',
    'dist/ssr/a\u0000',
    'db/migrations/a.sql/../x',
  ]) {
    expect(() =>
      parseCasimirManifest({ ...manifest(), files: [{ path, size: 1, sha256: hash }] }),
    ).toThrow();
  }
  for (const files of [
    [...manifest().files, ...manifest().files],
    [...manifest().files, { path: 'dist/ssr/APP.js', size: 1, sha256: hash }],
  ]) {
    expect(() => parseCasimirManifest({ ...manifest(), files })).toThrow('file_duplicate');
  }
  expect(() =>
    parseCasimirManifest({ ...manifest(), files: [{ ...manifest().files[0], size: -1 }] }),
  ).toThrow('file_size');
  expect(() =>
    parseCasimirManifest({
      ...manifest(),
      files: [{ ...manifest().files[0], sha256: 'B'.repeat(64) }],
    }),
  ).toThrow('file_hash');
  expect(() => parseCasimirManifest({ ...manifest(), envKeys: ['TOKEN', 'TOKEN'] })).toThrow(
    'env_keys',
  );
  expect(() =>
    parseCasimirManifest({
      ...manifest(),
      migrations: [{ name: 'a.sql', path: 'db/migrations/a.sql', sha256: hash }],
    }),
  ).toThrow('migration_file');
});
it('accepts Unicode/apostrophes and bounds file count and declared size', () => {
  const files = Array.from({ length: CASIMIR_LIMITS.files }, (_, i) => ({
    path: i === 0 ? 'dist/ssr/app.js' : `dist/client/${String(i).padStart(4, '0')}-é'.txt`,
    size: 0,
    sha256: hash,
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
  expect(parseCasimirManifest({ ...manifest(), files }).files).toHaveLength(4096);
  expect(() =>
    parseCasimirManifest({
      ...manifest(),
      files: [...files, { path: 'dist/client/z', size: 0, sha256: hash }],
    }),
  ).toThrow('file_count');
  expect(() =>
    parseCasimirManifest({
      ...manifest(),
      files: [{ ...manifest().files[0], size: CASIMIR_LIMITS.expanded + 1 }],
    }),
  ).toThrow('expanded_limit');
});
