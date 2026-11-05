import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CasimirFile, CasimirManifest } from '@void/deploy-core';

function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  for (const [offset, length, value] of [
    [100, 8, 0o444],
    [108, 8, 1000],
    [116, 8, 1000],
    [124, 12, size],
    [136, 12, 0],
  ] as const) {
    h.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  }
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(
    [...h]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
    'ascii',
  );
  return h;
}
function padding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}
function pax(path: string): Buffer {
  const body = ` path=${path}\n`;
  let size = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(size)) + Buffer.byteLength(body) !== size) {
    size = Buffer.byteLength(String(size)) + Buffer.byteLength(body);
  }
  return Buffer.from(String(size) + body);
}
/** Generates a regular-file-only build context. No client Dockerfile or build hooks. */
export async function* artifactImageContext(
  root: string,
  files: ReadonlyArray<CasimirFile>,
  runnerImage: string,
  manifest?: CasimirManifest,
): AsyncGenerator<Buffer> {
  if (!/^sha256:[a-f0-9]{64}$/.test(runnerImage)) {
    throw new Error('runner_image');
  }
  if (files.length > 4096) {
    throw new Error('artifact_limit');
  }
  const handles = [];
  let total = 0;
  try {
    for (const f of files) {
      if (
        !f.path ||
        f.path.startsWith('/') ||
        f.path.includes('\\') ||
        f.path.includes('\0') ||
        f.path.split('/').some((p) => !p || p === '.' || p === '..')
      ) {
        throw new Error('artifact_changed');
      }
      total += f.size;
      if (!Number.isSafeInteger(f.size) || f.size < 0 || total > 256 * 1024 * 1024) {
        throw new Error('artifact_limit');
      }
      let parent = root;
      for (const part of f.path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        if (!(await lstat(parent)).isDirectory()) {
          throw new Error('artifact_changed');
        }
      }
      const fd = await open(join(root, f.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push({ fd, file: f });
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size !== f.size) {
        throw new Error('artifact_changed');
      }
      const hash = createHash('sha256');
      for await (const chunk of fd.createReadStream({ autoClose: false, start: 0 })) {
        hash.update(chunk);
      }
      if (hash.digest('hex') !== f.sha256) {
        throw new Error('artifact_changed');
      }
    }
    const recipe = Buffer.from(`FROM ${runnerImage}\nCOPY --chown=1000:1000 payload/ /app/\n`);
    yield header('Dockerfile', recipe.length);
    yield recipe;
    yield padding(recipe.length);
    if (manifest) {
      const metadata = Buffer.from(JSON.stringify(manifest));
      yield header('payload/casimir-manifest.json', metadata.length);
      yield metadata;
      yield padding(metadata.length);
    }
    for (let i = 0; i < handles.length; i++) {
      const { fd, file } = handles[i];
      const path = 'payload/' + file.path;
      const meta = pax(path);
      yield header(`pax-${i}`, meta.length, 'x');
      yield meta;
      yield padding(meta.length);
      yield header(`file-${i}`, file.size);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of fd.createReadStream({ autoClose: false, start: 0 })) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (size !== file.size || hash.digest('hex') !== file.sha256) {
        throw new Error('artifact_changed');
      }
      yield padding(file.size);
    }
    yield Buffer.alloc(1024);
  } finally {
    await Promise.all(handles.map(({ fd }) => fd.close()));
  }
}
