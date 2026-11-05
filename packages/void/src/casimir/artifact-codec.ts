import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import * as posix from 'node:path/posix';
import { Transform, PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  CASIMIR_LIMITS,
  parseCasimirManifest,
  assertCasimirRuntime,
  canonicalJson,
  type RuntimeDescriptor,
  type CasimirManifest,
  type CasimirFile,
} from '@void/deploy-core';
import { dirname, join, resolve } from 'pathslash';
import { parseSync } from 'vite';
import { staticModuleReferences } from '../shared/module-references.ts';
export const MAGIC: Buffer = Buffer.from('CASIMIR1\n');
export function casimirByteLimit(max: number, code: string): Transform {
  let count = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      callback(count > max ? new Error(code) : null, chunk);
    },
  });
}
export async function fileHash(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
  }
  return h.digest('hex');
}
const allowed = new Set([
  ...builtinModules,
  ...builtinModules.map((n) => `node:${n}`),
  'better-sqlite3',
  '@hono/node-server',
  '@hono/node-server/serve-static',
]);
export async function validateModules(root: string, files: Array<CasimirFile>): Promise<void> {
  const paths = new Set(files.map((f) => f.path));
  for (const f of files) {
    if (!/\.[cm]?js$/.test(f.path)) {
      continue;
    }
    if (f.size > 4 * 1024 * 1024) {
      throw new Error('module_limit');
    }
    // Bounded by artifact limits; source modules are parsed without executing them.
    const code = await readFile(join(root, f.path), 'utf8');
    // A byte cap alone does not bound the lazily materialized JavaScript AST.
    // Count conservative raw lexemes before invoking the native parser. Strings
    // and comments also count: false positives reject a module, never omit code
    // from the real import/require syntax validation below.
    let lexemes = 0;
    const rawLexemes = /[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;
    while (rawLexemes.exec(code) !== null) {
      if (++lexemes > 400000) {
        throw new Error('module_complexity_limit');
      }
    }
    const parsed = parseSync(f.path, code, { lang: 'js', sourceType: 'module' });
    if (parsed.errors.length) {
      throw new Error('module_syntax');
    }
    const refs = staticModuleReferences(parsed, code).map((r) => r.source);
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item);
        }
        return;
      }
      const n = node as Record<string, unknown>;
      if (n.type === 'ImportExpression') {
        const s = n.source as {
          type: string;
          value?: unknown;
          expressions?: Array<unknown>;
          quasis?: Array<{ value: { cooked: string } }>;
        };
        const value =
          s.type === 'TemplateLiteral' && s.expressions?.length === 0
            ? s.quasis?.[0]?.value.cooked
            : s.value;
        if (typeof value !== 'string') {
          throw new Error(`dynamic_module: ${f.path} (${s.type})`);
        }
        refs.push(value);
      }
      if (n.type === 'CallExpression') {
        const callee = n.callee as { type?: string; name?: string };
        if (
          callee.type === 'Identifier' &&
          (callee.name === 'require' || callee.name === '__require')
        ) {
          const arg = (n.arguments as Array<{ type: string; value?: unknown }>)[0];
          if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') {
            throw new Error('dynamic_module');
          }
          refs.push(arg.value);
        }
      }
      for (const [key, value] of Object.entries(n)) {
        if (key !== 'parent') {
          walk(value);
        }
      }
    };
    walk(parsed.program);
    for (const ref of refs) {
      if (ref.startsWith('./') || ref.startsWith('../')) {
        if (!paths.has(posix.normalize(posix.join(posix.dirname(f.path), ref)))) {
          throw new Error('module_missing');
        }
      } else if (!allowed.has(ref)) {
        throw new Error(`module_external: ${f.path}: ${JSON.stringify(ref)}`);
      }
    }
  }
}
class Reader {
  private iterator: AsyncIterator<Buffer>;
  private chunk = Buffer.alloc(0);
  private offset = 0;
  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async take(max: number): Promise<Buffer> {
    if (this.offset === this.chunk.length) {
      const n = await this.iterator.next();
      if (n.done) {
        return Buffer.alloc(0);
      }
      this.chunk = n.value;
      this.offset = 0;
    }
    const part = this.chunk.subarray(this.offset, this.offset + max);
    this.offset += part.length;
    return part;
  }
  async exact(size: number): Promise<Buffer> {
    const parts: Array<Buffer> = [];
    let remaining = size;
    while (remaining) {
      const c = await this.take(remaining);
      if (!c.length) {
        throw new Error('artifact_truncated');
      }
      parts.push(c);
      remaining -= c.length;
    }
    return Buffer.concat(parts, size);
  }
}
export async function extractCasimirArtifact(
  path: string,
  destination: string,
  runtime: RuntimeDescriptor,
): Promise<{ manifest: CasimirManifest; sha256: string }> {
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
    throw new Error('destination_exists');
  }
  await mkdir(dirname(destination), { recursive: true });
  const pending = await mkdtemp(join(dirname(destination), '.casimir-extract-'));
  const output = new PassThrough();
  const done = pipeline(
    createReadStream(path),
    casimirByteLimit(CASIMIR_LIMITS.compressed, 'compressed_limit'),
    createGunzip(),
    casimirByteLimit(CASIMIR_LIMITS.expanded, 'expanded_limit'),
    output,
  );
  // Handle pipeline failure immediately while its consumer awaits the next chunk.
  void done.catch(() => {});
  try {
    const reader = new Reader(output);
    if (!(await reader.exact(MAGIC.length)).equals(MAGIC)) {
      throw new Error('artifact_magic');
    }
    const size = (await reader.exact(4)).readUInt32BE();
    if (size > CASIMIR_LIMITS.manifest) {
      throw new Error('manifest_limit');
    }
    const json = await reader.exact(size);
    const manifest = parseCasimirManifest(JSON.parse(json.toString('utf8')));
    assertCasimirRuntime(manifest, runtime);
    if (!Buffer.from(canonicalJson(manifest)).equals(json)) {
      throw new Error('manifest_canonical');
    }
    for (const f of manifest.files) {
      const target = resolve(pending, f.path);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      let remaining = f.size;
      try {
        while (remaining) {
          const chunk = await reader.take(remaining);
          if (!chunk.length) {
            throw new Error('artifact_truncated');
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const result = await handle.write(chunk, offset);
            offset += result.bytesWritten;
          }
          remaining -= chunk.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (hash.digest('hex') !== f.sha256) {
        throw new Error('file_hash');
      }
    }
    if ((await reader.take(1)).length) {
      throw new Error('artifact_trailing');
    }
    await done;
    await validateModules(pending, manifest.files);
    await rename(pending, destination);
    const parent = await open(dirname(destination), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { manifest, sha256: await fileHash(path) };
  } catch (error) {
    output.destroy();
    await done.catch(() => {});
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}
