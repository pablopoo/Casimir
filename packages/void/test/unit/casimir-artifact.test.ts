import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vite-plus/test';
import { buildCasimirArtifact, extractCasimirArtifact } from '../../src/cli/casimir-artifact.ts';
import { buildEnv } from '../../src/shared/untrusted-env.ts';

it('removes the origin-bound control token before executing project build/probe code', () => {
  expect(
    buildEnv({
      CASIMIR_TOKEN: 'synthetic-control',
      cAsImIr_ToKeN: 'synthetic-control',
      APP_KEY: 'app',
    }),
  ).toMatchObject({ APP_KEY: 'app' });
  expect(
    Object.keys(
      buildEnv({ CASIMIR_TOKEN: 'synthetic-control', cAsImIr_ToKeN: 'synthetic-control' }),
    ).some((k) => k.toLowerCase() === 'casimir_token'),
  ).toBe(false);
});
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
} as const;
const roots: Array<string> = [];
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'casimir-codec-'));
  roots.push(p);
  return p;
}
async function fixture() {
  const p = await root();
  await mkdir(join(p, 'dist/ssr'), { recursive: true });
  await mkdir(join(p, 'dist/client'), { recursive: true });
  await writeFile(join(p, 'dist/ssr/app.js'), 'export default {fetch:()=>new Response("hello")}');
  await writeFile(join(p, "dist/client/é'.txt"), 'hello Unicode 🪐');
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});
it('roundtrips canonical bytes deterministically through the shared manifest parser', async () => {
  const p = await fixture();
  const a = await buildCasimirArtifact(p, runtime),
    b = await buildCasimirArtifact(p, runtime);
  expect(a.sha256).toBe(b.sha256);
  expect(await readFile(a.path)).toEqual(await readFile(b.path));
  const out = join(await root(), 'extracted');
  const result = await extractCasimirArtifact(a.path, out, runtime);
  expect(result.manifest).toEqual(a.manifest);
  expect(await readFile(join(out, "dist/client/é'.txt"), 'utf8')).toBe('hello Unicode 🪐');
});
it('rejects trailing/truncated bytes, invalid file hash and forged manifest length without sealing output', async () => {
  const a = await buildCasimirArtifact(await fixture(), runtime);
  const raw = gunzipSync(await readFile(a.path));
  const forged = Buffer.from(raw);
  forged.writeUInt32BE(1024 * 1024 + 1, 9);
  const corrupt = Buffer.from(raw);
  corrupt[corrupt.length - 1] ^= 1;
  for (const data of [
    Buffer.concat([raw, Buffer.from('x')]),
    raw.subarray(0, -1),
    forged,
    corrupt,
  ]) {
    const p = join(await root(), 'bad.gz');
    await writeFile(p, gzipSync(data));
    const out = join(await root(), 'out');
    await expect(extractCasimirArtifact(p, out, runtime)).rejects.toThrow();
    await expect(readFile(join(out, 'dist/ssr/app.js'))).rejects.toThrow();
  }
});
it('rejects links, native addons, credentials and unsupported bare or dynamic module references', async () => {
  for (const code of [
    "import 'cloudflare:workers'",
    "import x from 'unprovided-package'; export default x",
    'export default import(globalThis.moduleName)',
    "const x = require('not-allowed')",
  ]) {
    const p = await fixture();
    await writeFile(join(p, 'dist/ssr/app.js'), code);
    await expect(buildCasimirArtifact(p, runtime)).rejects.toThrow();
  }
  for (const name of ['.env', 'binding.node']) {
    const p = await fixture();
    await writeFile(join(p, 'dist/ssr', name), 'secret');
    await expect(buildCasimirArtifact(p, runtime)).rejects.toThrow();
  }
  const p = await fixture();
  await symlink('/etc/passwd', join(p, 'dist/client/link'));
  await expect(buildCasimirArtifact(p, runtime)).rejects.toThrow();
});
it('accepts only the exact advertised runner ABI', async () => {
  const a = await buildCasimirArtifact(await fixture(), runtime);
  await expect(
    extractCasimirArtifact(a.path, join(await root(), 'out'), { ...runtime, nodeAbi: '999' }),
  ).rejects.toThrow('runtime_mismatch');
});

it('enforces the inclusive compressed byte boundary through the complete gzip decoder', async () => {
  const { Readable } = await import('node:stream');
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const max = 64 * 1024 * 1024;
  const a = await buildCasimirArtifact(await fixture(), runtime);
  const gzip = await readFile(a.path);
  const header = Buffer.from(gzip.subarray(0, 10));
  header[3] |= 0x10; // A legal gzip comment enlarges compressed input, not output.
  async function check(size: number) {
    async function* chunks() {
      yield header;
      let left = size - gzip.length - 1;
      const chunk = Buffer.alloc(65536, 0x61);
      while (left) {
        const n = Math.min(left, chunk.length);
        yield chunk.subarray(0, n);
        left -= n;
      }
      yield Buffer.from([0]);
      yield gzip.subarray(10);
    }
    const archive = join(await root(), 'boundary.gz');
    await pipeline(Readable.from(chunks()), createWriteStream(archive));
    return extractCasimirArtifact(archive, join(await root(), 'out'), runtime);
  }
  expect((await check(max)).manifest).toEqual(a.manifest);
  await expect(check(max + 1)).rejects.toThrow('compressed_limit');
});
it('accepts exactly 256MiB expanded framing and rejects one extra byte without buffering the payload', async () => {
  const { createHash } = await import('node:crypto');
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { createGzip } = await import('node:zlib');
  const { canonicalJson } = await import('@void/deploy-core');
  const limit = 256 * 1024 * 1024,
    code = Buffer.from('export default {}');
  for (const extra of [0, 1]) {
    let size = limit - 1024;
    let json: Buffer;
    let manifest: Record<string, unknown>;
    // Fixed length hex digests let framing converge without allocating a payload.
    while (true) {
      manifest = {
        ...runtime,
        entry: 'dist/ssr/app.js',
        files: [
          { path: 'dist/client/padding.bin', size, sha256: '0'.repeat(64) },
          {
            path: 'dist/ssr/app.js',
            size: code.length,
            sha256: createHash('sha256').update(code).digest('hex'),
          },
        ],
        migrations: [],
        envKeys: [],
        compatibilityEntry: null,
      };
      json = Buffer.from(canonicalJson(manifest));
      const next = limit + extra - 13 - json.length - code.length;
      if (next === size) {
        break;
      }
      size = next;
    }
    const zeros = Buffer.alloc(65536),
      hash = createHash('sha256');
    for (let left = size; left > 0; left -= zeros.length) {
      hash.update(zeros.subarray(0, Math.min(left, zeros.length)));
    }
    (manifest!.files as Array<{ sha256: string }>)[0].sha256 = hash.digest('hex');
    json = Buffer.from(canonicalJson(manifest!));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    async function* bytes() {
      yield Buffer.from('CASIMIR1\n');
      yield length;
      yield json;
      for (let left = size; left > 0; left -= zeros.length) {
        yield zeros.subarray(0, Math.min(left, zeros.length));
      }
      yield code;
    }
    const p = join(await root(), 'boundary.gz');
    await pipeline(Readable.from(bytes()), createGzip(), createWriteStream(p));
    const dest = join(await root(), 'out');
    if (extra) {
      await expect(extractCasimirArtifact(p, dest, runtime)).rejects.toThrow('expanded_limit');
    } else {
      expect((await extractCasimirArtifact(p, dest, runtime)).manifest.files[0].size).toBe(size);
    }
  }
}, 60000);

it('bounds individual JavaScript modules before allocating a parser AST in the API', async () => {
  const p = await fixture();
  await writeFile(join(p, 'dist/ssr/app.js'), ' '.repeat(4 * 1024 * 1024) + 'export default {}');
  await expect(buildCasimirArtifact(p, runtime)).rejects.toThrow('module_limit');
});

it('rejects dense syntax before materializing an unbounded parser AST', async () => {
  const p = await fixture();
  await writeFile(join(p, 'dist/ssr/app.js'), 'export default [' + '0,'.repeat(210000) + ']');
  await expect(buildCasimirArtifact(p, runtime)).rejects.toThrow('module_complexity_limit');
});
