import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(fixtureRoot, '../../..');
const workspaceRoot = resolve(packageRoot, '../../..');
const entry = resolve(fixtureRoot, 'client.mjs');
const outputDir = resolve(
  process.argv[2] ?? resolve(packageRoot, 'test/fixtures/.identity-transport-build'),
);
const trackedInputs = [
  entry,
  resolve(packageRoot, 'src/auth/identity-network.ts'),
  resolve(packageRoot, 'src/casimir/management/identity-policy.ts'),
  resolve(packageRoot, 'src/casimir/management/identity-transport.ts'),
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

mkdirSync(outputDir, { recursive: true });
const build = await rolldown({
  input: entry,
  platform: 'node',
  external: ['undici', /^node:/],
  tsconfig: resolve(packageRoot, 'tsconfig.json'),
  onLog(level, log, handler) {
    if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
    handler(level, log);
  },
});
const { output } = await build.write({
  dir: outputDir,
  format: 'esm',
  entryFileNames: 'client.mjs',
});
const bundlePath = resolve(outputDir, 'client.mjs');
const modules = [...new Set(output.flatMap((chunk) => Object.keys(chunk.modules ?? {})))].sort();
const imports = output.flatMap((chunk) => chunk.imports ?? []);
const manifest = {
  sourceInputs: Object.fromEntries(
    trackedInputs.map((path) => [
      path.slice(workspaceRoot.length + 1),
      sha256(readFileSync(path)),
    ]),
  ),
  bundle: {
    path: bundlePath,
    bytes: readFileSync(bundlePath).byteLength,
    sha256: sha256(readFileSync(bundlePath)),
  },
  modules,
  imports,
};
writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
await build.close();
