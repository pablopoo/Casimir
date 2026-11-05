import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';

execFileSync(process.execPath, ['platform/packages/api/scripts/build-admin-client.mjs'], {
  stdio: 'inherit',
});

const input = { checks: 'platform/packages/api/src/casimir/checks.ts' };
if (existsSync('platform/packages/api/src/casimir/main.ts'))
  input.main = 'platform/packages/api/src/casimir/main.ts';
for (const name of ['operator', 'executor']) {
  const path = `platform/packages/api/src/casimir/execution/${name === 'executor' ? 'main' : name}.ts`;
  if (existsSync(path)) input[name] = path;
}
if (existsSync('platform/packages/api/src/casimir/mvp/main.ts')) {
  input.mvpExecutor = 'platform/packages/api/src/casimir/mvp/main.ts';
}
if (existsSync('platform/packages/api/src/casimir/lifecycle/main.ts')) input.lifecycle = 'platform/packages/api/src/casimir/lifecycle/main.ts';
if (existsSync('casimir/install/auth-setup.mjs')) input.authSetup = 'casimir/install/auth-setup.mjs';
if (existsSync('casimir/install/management-checkpoint.mjs')) input.managementCheckpoint = 'casimir/install/management-checkpoint.mjs';
const build = await rolldown({
  input,
  platform: 'node',
  // The artifact decoder uses Vite's pinned JS parser. Keep its optional build
  // tooling imports behind the installed package's own entrypoint.
  external: ['vite', 'undici'],
  resolve: {
    alias: {
      '@void/platform/plans': resolve('packages/platform/src/plans.ts'),
      '@void/platform': resolve('packages/platform/src/index.ts'),
      '@void/deploy-core': resolve('packages/deploy-core/src/index.ts'),
    },
  },
  onLog(level, log, handler) {
    if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
    handler(level, log);
  },
});
const { output } = await build.write({
  dir: 'casimir/dist',
  format: 'esm',
  entryFileNames: '[name].mjs',
  banner:
    'import {createRequire as casimirCreateRequire} from "node:module"; const require=casimirCreateRequire(import.meta.url);',
});
const adminAssets = resolve('platform/packages/api/dist/admin-assets/admin');
const casimirAdminAssets = resolve('casimir/dist/admin');
mkdirSync(casimirAdminAssets, { recursive: true });
for (const asset of ['client.js', 'style.css']) {
  const source = resolve(adminAssets, asset);
  if (!existsSync(source)) throw new Error(`Missing original admin asset: ${asset}`);
  copyFileSync(source, resolve(casimirAdminAssets, asset));
}
const modules = [...new Set(output.flatMap((chunk) => Object.keys(chunk.modules ?? {})))].sort();
if (modules.some((name) => name.includes('/__mocks__/'))) throw new Error('Mock in Node build');
mkdirSync('casimir/dist', { recursive: true });
writeFileSync(
  'casimir/dist/provenance.json',
  JSON.stringify({ modules, imports: output.flatMap((c) => c.imports ?? []) }, null, 2),
);
await build.close();
