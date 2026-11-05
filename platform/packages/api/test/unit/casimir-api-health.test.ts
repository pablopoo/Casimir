import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';
import { expect, it } from 'vite-plus/test';
import { createFateClient } from '../../src/admin/fate/client.generated.ts';
import {
  createManagementProjectsFateServer,
  type ManagementApiHealthProbe,
} from '../../src/admin/fate/projects-server.ts';
import { healthRequest } from '../../src/admin/fate/views.ts';
import { probeLocalApiHealth } from '../../src/casimir/management/api-health.ts';
import type { Db } from '../../src/db.ts';
import type { PlatformManagementEnv } from '../../src/env.ts';

function findRecord(value: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecord(item, id);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.id === id) return record;
  for (const nested of Object.values(record)) {
    const found = findRecord(nested, id);
    if (found) return found;
  }
  return undefined;
}

async function queryHealth(apiHealthProbe?: ManagementApiHealthProbe) {
  const db = {
    execute: async () => ({ rows: [] }),
  } as unknown as Db;
  const fateServer = createManagementProjectsFateServer(undefined, undefined, apiHealthProbe);
  const app = new Hono<PlatformManagementEnv>();
  app.use('*', async (context, next) => {
    context.set('db', db);
    await next();
  });
  app.post('/admin/fate', (context) => fateServer.handleRequest(context.req.raw, context));

  let responseBody: unknown;
  const client = createFateClient({
    url: 'http://127.0.0.1/admin/fate',
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input, init));
      responseBody = await response.clone().json();
      return response;
    },
  });
  await client.request(healthRequest);

  const health = findRecord(responseBody, 'health');
  if (!health) throw new Error('management_health_record_missing');
  return health;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback_listener_unavailable');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

it('omits the API check when the Node health provider has no local probe', async () => {
  const health = await queryHealth();
  const checks = Array.isArray(health?.checks) ? health.checks : [];
  expect(checks.some((check) => (check as Record<string, unknown>).name === 'api')).toBe(false);
  expect(checks.some((check) => (check as Record<string, unknown>).name === 'db')).toBe(true);
  expect(health.allOk).toBe(false);
});

it('adds the injected API observation to the original Node Fate health record', async () => {
  let calls = 0;
  const health = await queryHealth(async () => {
    calls++;
    return { name: 'api', ok: true, latencyMs: 3.25 };
  });
  const checks = Array.isArray(health.checks) ? health.checks : [];
  expect(calls).toBe(1);
  expect(checks.find((check) => (check as Record<string, unknown>).name === 'api')).toMatchObject({
    name: 'api',
    ok: true,
    latencyMs: 3.25,
  });
  expect(health.allOk).toBe(false);
});

it('measures the real loopback GET /health response', async () => {
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: true }));
  });
  const port = await listen(server);

  try {
    const check = await probeLocalApiHealth(port);
    expect(check).toMatchObject({ name: 'api', ok: true });
    expect(check.latencyMs).toBeGreaterThan(0);
    expect(check.error).toBeUndefined();
    expect(requests).toEqual([{ method: 'GET', path: '/health', authorization: undefined }]);
  } finally {
    await close(server);
  }
});

it('reports non-ready, invalid, and redirect responses as unhealthy without following redirects', async () => {
  let responseSpec: { status: number; body: string; location?: string } = {
    status: 503,
    body: JSON.stringify({ ready: false }),
  };
  const requestPaths: Array<string> = [];
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? '');
    response.writeHead(responseSpec.status, {
      'Content-Type': 'application/json',
      ...(responseSpec.location ? { Location: responseSpec.location } : {}),
    });
    response.end(responseSpec.body);
  });
  const port = await listen(server);

  try {
    const unavailable = await probeLocalApiHealth(port);
    expect(unavailable).toMatchObject({
      name: 'api',
      ok: false,
      error: 'Health endpoint returned HTTP 503.',
    });
    expect(unavailable.latencyMs).toBeGreaterThan(0);

    responseSpec = { status: 200, body: JSON.stringify({ ready: false }) };
    const notReady = await probeLocalApiHealth(port);
    expect(notReady).toMatchObject({ ok: false, error: 'Health endpoint did not report ready.' });

    responseSpec = { status: 200, body: 'not-json' };
    const invalid = await probeLocalApiHealth(port);
    expect(invalid).toMatchObject({
      ok: false,
      error: 'Health endpoint returned invalid readiness data.',
    });

    responseSpec = { status: 302, body: '', location: '/ready' };
    const redirect = await probeLocalApiHealth(port);
    expect(redirect).toMatchObject({ ok: false, error: 'Health endpoint returned HTTP 302.' });
    expect(requestPaths).toEqual(['/health', '/health', '/health', '/health']);
  } finally {
    await close(server);
  }
});

it('bounds a stalled loopback health response to two seconds', async () => {
  const server = createServer((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
    }, 3000);
    response.once('close', () => clearTimeout(timer));
  });
  const port = await listen(server);

  try {
    const startedAt = performance.now();
    const check = await probeLocalApiHealth(port);
    const elapsedMs = performance.now() - startedAt;
    expect(check).toMatchObject({
      name: 'api',
      ok: false,
      error: 'Local API health check timed out after 2 seconds.',
    });
    expect(check.latencyMs).toBeGreaterThanOrEqual(1900);
    expect(check.latencyMs).toBeLessThan(3000);
    expect(elapsedMs).toBeLessThan(3000);
  } finally {
    await close(server);
  }
});

it('sanitizes a loopback connection failure', async () => {
  const server = createServer((_request, response) => response.end('unexpected'));
  const port = await listen(server);
  await close(server);

  const check = await probeLocalApiHealth(port);
  expect(check).toMatchObject({
    name: 'api',
    ok: false,
    error: 'Could not reach the local API health endpoint.',
  });
  expect(check.latencyMs).toBeGreaterThan(0);
  expect(check.error).not.toContain('127.0.0.1');
});
