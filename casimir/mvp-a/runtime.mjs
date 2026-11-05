import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path/posix';
import { rolldown } from 'rolldown';
const root = resolve('casimir/mvp-a/runner');
const build = await rolldown({
  input: 'packages/void/src/casimir/migrations.ts',
  platform: 'node',
  external: ['better-sqlite3'],
  resolve: { alias: { '@void/deploy-core': resolve('packages/deploy-core/src/index.ts') } },
});
await build.write({ file: root + '/dist/migrations.mjs', format: 'esm' });
await build.close();
const hash = createHash('sha256');
for (const name of [
  'Dockerfile',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bootstrap.mjs',
  'job.mjs',
  'dist/migrations.mjs',
]) {
  hash
    .update(name + '\0')
    .update(await readFile(root + '/' + name))
    .update('\0');
}
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: JSON.parse(await readFile(root + '/package.json', 'utf8')).casimirSdkVersion,
  runtimeId: hash.digest('hex'),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
await mkdir(root + '/dist', { recursive: true });
await writeFile(root + '/dist/runtime.json', JSON.stringify(runtime));
console.log(JSON.stringify(runtime));
