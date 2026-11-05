import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function startupEnv(keys, values) {
  if (!Array.isArray(keys) || !values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('runtime_env');
  }
  const env = {};
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      key.startsWith('CASIMIR_') ||
      key.startsWith('__') ||
      ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)
    ) {
      throw new Error('runtime_env');
    }
    if (Object.hasOwn(values, key)) {
      if (typeof values[key] !== 'string') {
        throw new Error('runtime_env');
      }
      env[key] = values[key];
    }
  }
  return Object.freeze({ ...env, CASIMIR_SQLITE_PATH: '/data/app.sqlite' });
}
export function runtimeFetch(app, release) {
  const identity = {};
  let origin;
  if (release.origin !== undefined) {
    origin = new URL(release.origin);
    if (origin.origin !== release.origin || !['http:', 'https:'].includes(origin.protocol)) {
      throw new Error('runtime_origin');
    }
  }
  for (const [key, prefix] of [
    ['projectId', 'proj'],
    ['deploymentId', 'dpl'],
    ['artifactId', 'car'],
  ]) {
    if (!new RegExp(`^${prefix}_[a-z0-9]{12}$`).test(release[key])) {
      throw new Error('runtime_identity');
    }
    identity[key] = release[key];
  }
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/_casimir/identity' && request.method === 'GET') {
      return Response.json(identity);
    }
    if (path === '/_casimir/health' && request.method === 'GET') {
      return Response.json({ ok: true, ...identity });
    }
    if (path.startsWith('/_casimir/')) {
      return new Response('Not found', { status: 404 });
    }
    if (origin) {
      const incoming = new URL(request.url);
      if (incoming.host !== origin.host || (request.headers.has('origin') && request.headers.get('origin') !== origin.origin)) {
        return new Response('Forbidden', { status: 403 });
      }
      // The operator-owned release chooses the public origin, never a client
      // Forwarded header. TLS termination may use HTTP on the private network.
      request = new Request(new URL(incoming.pathname + incoming.search, origin), request);
    }
    return app.fetch(request);
  };
}
async function main() {
  const { default: Database } = await import('better-sqlite3');
  const smoke = new Database(':memory:');
  if (process.versions.modules !== '137' || smoke.prepare('select 7 n').get().n !== 7) {
    throw new Error('runtime_abi');
  }
  smoke.close();
  if (process.argv[2] === 'smoke') {
    console.log(
      JSON.stringify({
        nodeAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
        native: true,
      }),
    );
    return;
  }
  const manifest = JSON.parse(await readFile('/app/casimir-manifest.json', 'utf8'));
  if (manifest.nodeAbi !== process.versions.modules || manifest.entry !== 'dist/ssr/app.js') {
    throw new Error('runtime_profile');
  }
  const release = JSON.parse(await readFile('/run/casimir/release.json', 'utf8'));
  const values = JSON.parse(await readFile('/run/casimir/env.json', 'utf8'));
  globalThis[Symbol.for('casimir.startupEnv.v1')] = startupEnv(manifest.envKeys, values);
  const { default: app } = await import('/app/dist/ssr/app.js');
  if (!app || typeof app.fetch !== 'function') {
    throw new Error('runtime_entry');
  }
  // Exercise application env validation before the reserved health endpoint exists.
  const probe = await app.fetch(new Request('http://localhost/_casimir/preflight'));
  if (probe.status >= 500) {
    throw new Error('runtime_preflight');
  }
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: runtimeFetch(app, release), port: 3000, hostname: '0.0.0.0' });
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('casimir_runtime_failed');
    process.exitCode = 1;
  });
}
