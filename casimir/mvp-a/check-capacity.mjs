import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
const { Client } = createRequire(
  new URL('../../platform/packages/api/package.json', import.meta.url),
)('pg');
const origin = 'http://casimir-mvp-a-control-ingress:8080';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
async function request(path, body, method = 'POST', binary = false, expected) {
  const response = await fetch(origin + path, {
    method: method === 'PUT' ? 'PUT' : 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.CASIMIR_TOKEN,
      'Content-Type': binary ? 'application/octet-stream' : 'application/json',
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    expected ?? (method === 'PUT' ? 200 : path.endsWith('/uploads') ? 201 : 200),
    JSON.stringify(result),
  );
  return result;
}
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin + '/health')).status === 200) {
        break;
      }
    } catch {
      // A just-recreated API may not be listening yet.
    }
    if (attempt === 99) {
      throw new Error('capacity_api_not_ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const projects = await db.query("SELECT id FROM projects WHERE slug='mvp-notes'");
  assert.equal(projects.rows.length, 1);
  const runtime = await (await fetch(origin + '/casimir/v1/info')).json();
  // Dense syntax exercises parser allocation, unlike a large comment or binary.
  const reject = process.argv[2] === 'reject';
  const dense =
    'export const values=[' + '0,'.repeat(reject ? 210000 : 199980) + '];export default {};';
  const code = Buffer.from(dense + '/*' + 'x'.repeat(4 * 1024 * 1024 - dense.length - 4) + '*/');
  assert.ok(code.length <= 4 * 1024 * 1024);
  const manifest = {
    ...runtime,
    entry: 'dist/ssr/app.js',
    files: [{ path: 'dist/ssr/app.js', size: code.length, sha256: sha(code) }],
    migrations: [],
    envKeys: [],
    compatibilityEntry: null,
  };
  const encoded = Buffer.from(canonical(manifest)),
    size = Buffer.alloc(4);
  size.writeUInt32BE(encoded.length);
  const compressed = gzipSync(Buffer.concat([Buffer.from('CASIMIR1\n'), size, encoded, code]));
  const filler = Buffer.alloc(64 * 1024 * 1024 - compressed.length, 97);
  filler[filler.length - 1] = 0;
  const header = Buffer.from(compressed.subarray(0, 10));
  header[3] |= 16;
  const bytes = Buffer.concat([header, filler, compressed.subarray(10)]);
  assert.equal(bytes.length, 64 * 1024 * 1024);
  const path = '/casimir/v1/projects/' + projects.rows[0].id;
  const upload = await request(path + '/uploads', { bytes: bytes.length, sha256: sha(bytes) });
  await request(path + '/uploads/' + upload.uploadId + '/content', bytes, 'PUT', true);
  const result = await request(
    path + '/uploads/' + upload.uploadId + '/finalize',
    {},
    'POST',
    false,
    reject ? 400 : 200,
  );
  if (reject) {
    assert.equal(result.error, 'invalid native artifact');
  } else {
    assert.match(result.artifactId, /^car_/);
  }
  assert.equal((await fetch(origin + '/health')).status, 200);
  console.log(
    JSON.stringify({
      gate: reject ? '512MiB-api-density-rejection' : '512MiB-api-finalization',
      artifactId: result.artifactId,
      wireBytes: bytes.length,
      moduleBytes: code.length,
    }),
  );
} finally {
  await db.end();
}
