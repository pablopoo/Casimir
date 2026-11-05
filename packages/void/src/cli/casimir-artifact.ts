import { createWriteStream, constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import * as posix from 'node:path/posix';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  CASIMIR_LIMITS,
  parseCasimirManifest,
  canonicalJson,
  validateCasimirPath,
  type RuntimeDescriptor,
  type CasimirManifest,
  type CasimirFile,
} from '@void/deploy-core';
import { join } from 'pathslash';
import {
  MAGIC,
  fileHash,
  validateModules,
  casimirByteLimit,
  extractCasimirArtifact,
} from '../casimir/artifact-codec.ts';
export { casimirByteLimit, extractCasimirArtifact } from '../casimir/artifact-codec.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { resolveEnvSchemaFactsViaSubprocess } from './env-schema-probe.ts';
async function collect(root: string, dir: string, out: Array<CasimirFile>): Promise<void> {
  const absolute = join(root, dir);
  const info = await lstat(absolute).catch((e) => {
    if (e.code === 'ENOENT') {
      return null;
    }
    throw e;
  });
  if (!info) {
    return;
  }
  if (info.isSymbolicLink()) {
    throw new Error('file_link');
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) {
      await collect(root, `${dir}/${name}`, out);
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error('file_type');
  }
  try {
    validateCasimirPath(dir);
  } catch {
    throw new Error(`file_path: ${JSON.stringify(dir)}`);
  }
  if (out.length >= CASIMIR_LIMITS.files) {
    throw new Error('file_count');
  }
  out.push({ path: dir, size: info.size, sha256: await fileHash(absolute) });
}
export async function buildCasimirArtifact(
  root: string,
  runtime: RuntimeDescriptor,
): Promise<{ path: string; sha256: string; manifest: CasimirManifest }> {
  const files: Array<CasimirFile> = [];
  for (const dir of ['dist/ssr', 'dist/client', 'db/migrations', 'compatibility']) {
    await collect(root, dir, files);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const facts = await resolveEnvSchemaFactsViaSubprocess(
    { root },
    buildEnv(undefined, { localBinRoot: root }),
  );
  if (facts.kind !== 'ok') {
    throw new Error('env_schema');
  }
  const manifest = parseCasimirManifest({
    ...runtime,
    entry: 'dist/ssr/app.js',
    files,
    migrations: files
      .filter((f) => f.path.startsWith('db/migrations/'))
      .map((f) => ({ name: posix.basename(f.path), path: f.path, sha256: f.sha256 })),
    envKeys: [...facts.facts.serverKeys].sort(),
    compatibilityEntry: files.some((f) => f.path === 'compatibility/check.js')
      ? 'compatibility/check.js'
      : null,
  });
  await validateModules(root, files);
  const json = Buffer.from(canonicalJson(manifest));
  if (json.length > CASIMIR_LIMITS.manifest) {
    throw new Error('manifest_limit');
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  await mkdir(join(root, '.void', 'artifacts'), { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(root, '.void', 'artifacts', 'artifact-'));
  const pending = join(folder, 'artifact.pending'),
    path = join(folder, 'artifact.gz');
  async function* bytes() {
    yield MAGIC;
    yield length;
    yield json;
    for (const f of files) {
      const handle = await open(join(root, f.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      yield* handle.createReadStream();
    }
  }
  try {
    await pipeline(
      Readable.from(bytes()),
      casimirByteLimit(CASIMIR_LIMITS.expanded, 'expanded_limit'),
      createGzip({ level: 9 }),
      casimirByteLimit(CASIMIR_LIMITS.compressed, 'compressed_limit'),
      createWriteStream(pending, { flags: 'wx', mode: 0o600 }),
    );
    // Re-read through the server decoder before returning a sealed client artifact.
    const verify = join(folder, 'verified');
    await extractCasimirArtifact(pending, verify, runtime);
    await rm(verify, { recursive: true });
    const handle = await open(pending, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, path);
    return { path, sha256: await fileHash(path), manifest };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
