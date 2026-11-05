import { Hono } from 'hono';
import { describe, expect, test } from 'vite-plus/test';
import { adminCsrfMiddleware } from '../../src/admin/middleware/csrf.ts';
import { createCasimirManagementFetchHandler } from '../../src/casimir/management/host.ts';
import type { CasimirManagementConfig } from '../../src/casimir/management/enrollment.ts';
import { createCasimirManagementRequestHandler } from '../../src/casimir/management/origin-boundary.ts';
import type { ApiEnv } from '../../src/env.ts';

const controlOrigin = 'https://control.example';
const bindings = {} as ApiEnv['Bindings'];
const managementConfig: CasimirManagementConfig = {
  format: 1,
  installationId: 'a'.repeat(32),
  ownershipNonce: 'b'.repeat(48),
  jwtSecret: 'c'.repeat(64),
  authSetupToken: 'd'.repeat(64),
  projectSecretKeysJson: '{}',
  projectSecretActiveKeyVersion: '1',
  operatorId: 'user_abcdefghijkl',
  projectId: 'proj_abcdefghijkl',
};

function dispatch(app: Hono<ApiEnv>, request: Request): Promise<Response> | Response {
  const handler = createCasimirManagementRequestHandler(controlOrigin, (nextRequest) =>
    app.fetch(nextRequest, bindings),
  );
  return handler(request);
}

function probeApp(): Hono<ApiEnv> {
  return new Hono<ApiEnv>().all('*', async (context) => {
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)
      ? ''
      : await context.req.text();
    return context.json({
      url: context.req.url,
      method: context.req.method,
      requestId: context.req.header('X-Request-Id') ?? null,
      setupProof: context.req.header('X-Void-Auth-Setup') ?? null,
      body,
    });
  });
}

function routeProbeApp(): Hono<ApiEnv> {
  return new Hono<ApiEnv>()
    .post('/admin/action', (context) =>
      context.json({ route: 'admin-action', url: context.req.url, path: context.req.path }),
    )
    .post('/auth/bootstrap', (context) =>
      context.json({ route: 'auth-bootstrap', url: context.req.url, path: context.req.path }),
    )
    .get('/admin', (context) =>
      context.json({ route: 'admin-root', url: context.req.url, path: context.req.path }),
    )
    .get('/admin/', (context) =>
      context.json({ route: 'admin-slash', url: context.req.url, path: context.req.path }),
    )
    .notFound((context) =>
      context.json({ route: null, url: context.req.url, path: context.req.path }, 404),
    );
}

function csrfApp(): Hono<ApiEnv> {
  return new Hono<ApiEnv>()
    .use('/admin/*', adminCsrfMiddleware)
    .post('/admin/action', (context) => context.text(new URL(context.req.url).origin));
}

describe('Casimir trusted management request origin', () => {
  test('serves the branded admin icon only from the configured control origin', async () => {
    const handler = createCasimirManagementFetchHandler({
      db: {} as never,
      config: managementConfig,
      controlOrigin,
      appOrigin: 'https://app.example',
      assets: { clientJs: new Uint8Array(), styleCss: new Uint8Array() },
      dispatch: () => new Response('unexpected fallback', { status: 404 }),
    });

    try {
      const icon = await handler(
        new Request('https://control.example/admin/casimir-mark.svg', {
          headers: { Host: 'control.example' },
        }),
      );
      expect(icon.status).toBe(200);
      expect(icon.headers.get('content-type')).toContain('image/svg+xml');
      expect(await icon.text()).toContain('<svg');

      const oldAppOrigin = await handler(
        new Request('https://app.example/admin/casimir-mark.svg', {
          headers: { Host: 'app.example' },
        }),
      );
      expect(oldAppOrigin.status).toBe(421);
    } finally {
      await handler.close();
    }
  });

  test.each([
    'http://control.example',
    'https://operator:secret@control.example',
    'https://control.example/admin',
    'https://control.example?mode=admin',
    'https://control.example#admin',
  ])('rejects invalid configured control origin %s', (origin) => {
    expect(() => createCasimirManagementRequestHandler(origin, () => new Response())).toThrow(
      'control_origin_invalid',
    );
  });

  test('passes a matching public HTTPS Origin through the internal HTTP proxy to original admin CSRF', async () => {
    const response = await dispatch(
      csrfApp(),
      new Request('http://control.example/admin/action?source=browser', {
        method: 'POST',
        headers: {
          Host: 'control.example',
          Origin: 'https://control.example',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('https://control.example');
  });

  test('preserves a matching direct HTTPS management request', async () => {
    const request = new Request('https://control.example/admin/action?source=direct', {
      headers: { Host: 'control.example' },
    });
    const response = await dispatch(probeApp(), request);
    const result = (await response.json()) as { url: string };

    expect(result.url).toBe(request.url);
  });

  test.each([
    { path: '/%61dmin/action', route: 'admin-action' },
    { path: '/auth/%62ootstrap', route: 'auth-bootstrap' },
  ])('canonicalizes the Hono-decoded management route $path', async ({ path, route }) => {
    const app = routeProbeApp();
    const request = new Request(`http://control.example${path}`, {
      method: 'POST',
      headers: { Host: 'control.example' },
    });
    const response = await dispatch(app, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      route,
      url: `https://control.example${path}`,
    });
  });

  test.each(['/%61dmin/action', '/auth/%62ootstrap'])(
    'rejects a foreign Host when Hono decodes management path %s',
    async (path) => {
      const app = routeProbeApp();
      const request = new Request(`http://attacker.example${path}`, {
        method: 'POST',
        headers: { Host: 'attacker.example' },
      });
      const response = await dispatch(app, request);
      expect(response.status).toBe(421);
    },
  );

  test.each([
    { path: '/admin%2Faction', method: 'POST' },
    { path: '/auth/bootstrap/', method: 'POST' },
  ])(
    'keeps unrouted encoded-slash/trailing-slash path $path untouched',
    async ({ path, method }) => {
      const app = routeProbeApp();
      const request = new Request(`http://attacker.example${path}`, {
        method,
        headers: { Host: 'attacker.example' },
      });
      const response = await dispatch(app, request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        route: null,
        url: request.url,
        path,
      });
    },
  );

  test('canonicalizes the actual admin trailing-slash route', async () => {
    const request = new Request('http://control.example/admin/', {
      headers: { Host: 'control.example' },
    });
    const response = await dispatch(routeProbeApp(), request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      route: 'admin-slash',
      url: 'https://control.example/admin/',
    });
  });

  test.each([
    { path: '/admin', method: 'GET' },
    { path: '/admin/action?source=browser', method: 'POST' },
    { path: '/setup?step=owner', method: 'GET' },
    { path: '/auth/bootstrap', method: 'POST' },
    { path: '/auth/bootstrap/confirm', method: 'POST' },
    { path: '/auth/callback?code=synthetic', method: 'GET' },
  ])(
    'normalizes exact management path $path and preserves request data',
    async ({ path, method }) => {
      const body = method === 'POST' ? '{"setup":"synthetic"}' : undefined;
      const response = await dispatch(
        probeApp(),
        new Request(`http://control.example${path}`, {
          method,
          headers: {
            Host: 'control.example',
            'X-Request-Id': 'request-123',
          },
          ...(body === undefined ? {} : { body }),
        }),
      );
      const result = (await response.json()) as {
        url: string;
        method: string;
        requestId: string | null;
        body: string;
      };

      expect(result).toMatchObject({
        url: `https://control.example${path}`,
        method,
        requestId: 'request-123',
        body: body ?? '',
      });
    },
  );

  test('canonicalizes the signed internal auth-initialize request without changing its proof or body', async () => {
    const response = await dispatch(
      probeApp(),
      new Request('http://control.example/internal/platform/auth-initialize?source=installer', {
        method: 'POST',
        headers: {
          Host: 'control.example',
          'Content-Type': 'application/json',
          'X-Void-Auth-Setup': 'synthetic-signature',
        },
        body: '{"installation":"synthetic"}',
      }),
    );
    const result = (await response.json()) as {
      url: string;
      method: string;
      setupProof: string | null;
      body: string;
    };

    expect(result).toEqual({
      url: 'https://control.example/internal/platform/auth-initialize?source=installer',
      method: 'POST',
      requestId: null,
      setupProof: 'synthetic-signature',
      body: '{"installation":"synthetic"}',
    });
  });

  test.each([
    '/administrator',
    '/administer',
    '/setup-extra',
    '/auth/bootstrapper',
    '/auth/bootstrap/confirm-extra',
    '/auth/callback-extra',
    '/internal/platform/auth-initialize-extra',
    '/auth/login',
    '/auth/exchange',
    '/auth/cli/token',
    '/auth/github-oidc',
    '/health',
    '/projects',
  ])('leaves non-management path %s untouched', async (path) => {
    const request = new Request(`http://other.example${path}?keep=1`, {
      headers: { Host: 'other.example' },
    });
    const response = await dispatch(probeApp(), request);
    const result = (await response.json()) as { url: string; method: string };

    expect(response.status).toBe(200);
    expect(result).toEqual({
      url: request.url,
      method: 'GET',
      requestId: null,
      setupProof: null,
      body: '',
    });
  });

  test.each([
    {
      requestUrl: 'http://attacker.example/admin/action',
      host: 'attacker.example',
      forwarded: { 'X-Forwarded-Host': 'control.example', 'X-Forwarded-Proto': 'https' },
    },
    {
      requestUrl: 'http://control.example/admin/action',
      host: 'attacker.example',
      forwarded: {},
    },
    {
      requestUrl: 'https://control.example/admin/action',
      host: 'attacker.example',
      forwarded: {},
    },
    {
      requestUrl: 'http://control.example/admin/action',
      host: 'control.example:444',
      forwarded: {},
    },
    {
      requestUrl: 'http://control.example/admin/action',
      host: 'control.example/path',
      forwarded: {},
    },
    {
      requestUrl: 'http://control.example/admin/action',
      host: 'control.example:notaport',
      forwarded: {},
    },
  ])(
    'rejects untrusted or malformed Host for a management path',
    async ({ requestUrl, host, forwarded }) => {
      const headers = new Headers({ Host: host });
      for (const [name, value] of Object.entries(forwarded)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const response = await dispatch(probeApp(), new Request(requestUrl, { headers }));

      expect(response.status).toBe(421);
    },
  );

  test('ignores hostile Forwarded headers as authority and normalizes from the validated Host', async () => {
    const response = await dispatch(
      probeApp(),
      new Request('http://control.example/admin/action', {
        headers: {
          Host: 'control.example',
          Forwarded: 'host=attacker.example;proto=http',
          'X-Forwarded-Host': 'attacker.example',
          'X-Forwarded-Proto': 'http',
        },
      }),
    );
    const result = (await response.json()) as { url: string };

    expect(result.url).toBe('https://control.example/admin/action');
  });

  test.each([
    { name: 'matching HTTPS Origin', headers: { Origin: 'https://control.example' }, status: 200 },
    { name: 'wrong scheme', headers: { Origin: 'http://control.example' }, status: 403 },
    { name: 'wrong host', headers: { Origin: 'https://attacker.example' }, status: 403 },
    { name: 'null Origin', headers: { Origin: 'null' }, status: 403 },
    { name: 'missing Origin and Referer', headers: {}, status: 403 },
    {
      name: 'valid Referer fallback',
      headers: { Referer: 'https://control.example/admin/form' },
      status: 200,
    },
    {
      name: 'wrong-scheme Referer fallback',
      headers: { Referer: 'http://control.example/admin/form' },
      status: 403,
    },
  ])('retains original admin CSRF policy for $name', async ({ headers, status }) => {
    const requestHeaders = new Headers({ Host: 'control.example' });
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') requestHeaders.set(name, value);
    }
    const response = await dispatch(
      csrfApp(),
      new Request('http://control.example/admin/action', {
        method: 'POST',
        headers: requestHeaders,
      }),
    );

    expect(response.status).toBe(status);
  });

  test('preserves redirects and each Set-Cookie response header', async () => {
    const app = new Hono<ApiEnv>().get('/admin/redirect', () => {
      const headers = new Headers({ Location: '/admin/' });
      headers.append('Set-Cookie', 'first=one; Path=/; Secure; HttpOnly; SameSite=Lax');
      headers.append('Set-Cookie', 'second=two; Path=/; Secure; HttpOnly; SameSite=Strict');
      return new Response(null, { status: 302, headers });
    });
    const response = await dispatch(
      app,
      new Request('http://control.example/admin/redirect', {
        headers: { Host: 'control.example' },
        redirect: 'manual',
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/');
    expect(response.headers.getSetCookie()).toEqual([
      'first=one; Path=/; Secure; HttpOnly; SameSite=Lax',
      'second=two; Path=/; Secure; HttpOnly; SameSite=Strict',
    ]);
  });
});
