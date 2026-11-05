import { createHash, createHmac, randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { PLATFORM_AUTH_SETUP_PROOF_PREFIX } from '@void/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApp } from '../../src/casimir/app.ts';
import { bootstrapInstallationDatabase } from '../../src/casimir/lifecycle/bootstrap.ts';
import {
  initializeInstallation,
  type InstallIdentity,
} from '../../src/casimir/lifecycle/identity.ts';
import {
  adoptCasimirManagementOwner,
  prepareCasimirManagementOwner,
  publishCasimirManagementConfig,
  type CasimirManagementConfig,
} from '../../src/casimir/management/enrollment.ts';
import { hashLoginProof } from '../../src/auth/proofs.ts';
import {
  operatorEvents,
  platformAuthBootstrap,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginRevisions,
  users,
} from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

const controlOrigin = 'https://control.example.com';
const managementConfig: CasimirManagementConfig = {
  format: 1,
  installationId: 'a'.repeat(32),
  ownershipNonce: 'b'.repeat(48),
  jwtSecret: 'c'.repeat(64),
  authSetupToken: 'd'.repeat(64),
  projectSecretKeysJson: JSON.stringify({
    '1': Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  }),
  projectSecretActiveKeyVersion: '1',
  operatorId: 'user_abcdefghijkl',
  projectId: 'proj_abcdefghijkl',
};
const mvpProfile = {
  runtime: {
    protocol: 1 as const,
    profile: 'node-sqlite-v1' as const,
    sdkVersion: '1.1.11',
    runtimeId: 'e'.repeat(64),
    platform: 'linux/amd64' as const,
    nodeAbi: '137',
  },
  artifactRoot: '/tmp/casimir-management-ui-http',
  installationId: managementConfig.installationId,
  origins: { control: controlOrigin, app: 'https://app.example.com:8444' },
};

let env: TestEnv;
let adminAssets: { clientJs: Buffer; styleCss: Buffer };

function request(server: ReturnType<typeof serve>, path: string, headers: Record<string, string> = {}) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('node_server_address_unavailable');
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: 'GET',
        headers: { Host: 'control.example.com', ...headers },
      },
      (incoming) => {
        const chunks: Array<Buffer> = [];
        incoming.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        incoming.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function postJson(
  server: ReturnType<typeof serve>,
  path: string,
  body: string,
  signature: string,
) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('node_server_address_unavailable');
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: 'POST',
        headers: {
          Host: 'control.example.com',
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'X-Void-Auth-Setup': signature,
        },
      },
      (incoming) => {
        const chunks: Array<Buffer> = [];
        incoming.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        incoming.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function resetC1FixtureDatabase() {
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_install CASCADE`);
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_mvp_a CASCADE`);
  await env.db.execute(sql`DROP TABLE IF EXISTS public.__void_platform_installation`);
  await clearTables(env.db);
}

async function prepareC1ControlSchemaForPGlite() {
  const source = await readFile(
    new URL('../../src/casimir/lifecycle/migrations/0001_lifecycle.sql', import.meta.url),
    'utf8',
  );
  const hash = createHash('sha256').update(source).digest('hex');
  await env.db.execute(sql`CREATE SCHEMA casimir_install`);
  await env.db.execute(sql`
    CREATE TABLE casimir_install.schema_migrations (
      version integer PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const statement of source.split(';').map((part) => part.trim()).filter(Boolean)) {
    await env.db.execute(sql.raw(statement));
  }
  await env.db.execute(sql`
    INSERT INTO casimir_install.schema_migrations(version, hash) VALUES (1, ${hash})
  `);
}

beforeAll(async () => {
  env = await setupEnv();
  adminAssets = {
    clientJs: await readFile(new URL('../../../../../casimir/dist/admin/client.js', import.meta.url)),
    styleCss: await readFile(new URL('../../../../../casimir/dist/admin/style.css', import.meta.url)),
  };
});

afterAll(async () => {
  await teardownEnv();
});

describe('Casimir original management UI over the native Node HTTP adapter', () => {
  it('serves the original admin login page before CLI bearer authentication', async () => {
    await clearTables(env.db);
    const app = createApp({
      db: env.db,
      token: 'synthetic-cli-bearer-token',
      operatorId: managementConfig.operatorId,
      mvpProfile,
      management: { controlOrigin, config: managementConfig, assets: adminAssets },
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const response = await request(server, '/admin/login');
      const html = response.body;

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(html).toContain('Admin Login');
      expect(html).toContain('Casimir');
      expect(html).toContain('/admin/casimir-mark.svg');
      expect(html).toContain('/admin/client.js');
      expect(html).toContain('/admin/style.css');

      const mark = await request(server, '/admin/casimir-mark.svg');
      expect(mark.status).toBe(200);
      expect(mark.headers['content-type']).toContain('image/svg+xml');
      expect(mark.body).toContain('<svg');
      const appOriginMark = await request(server, '/admin/casimir-mark.svg', {
        Host: 'app.example.com:8444',
      });
      expect(appOriginMark.status).toBe(421);

      const client = await request(server, '/admin/client.js');
      const stylesheet = await request(server, '/admin/style.css');
      expect(client.status).toBe(200);
      expect(client.headers['content-type']).toContain('application/javascript');
      expect(Buffer.byteLength(client.body)).toBeGreaterThan(500_000);
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers['content-type']).toContain('text/css');
      expect(Buffer.byteLength(stylesheet.body)).toBeGreaterThan(100_000);

      const unmanagedCallback = await request(server, '/auth/callback?state=github.invalid');
      expect(unmanagedCallback.status).toBe(400);
      expect(unmanagedCallback.headers['cache-control']).toBe('no-store');
      expect(unmanagedCallback.headers['referrer-policy']).toBe('no-referrer');

      const cliRequest = await request(server, '/projects', {
        Cookie: 'admin_token=not-a-cli-token',
      });
      expect(cliRequest.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects management keys bound to a different seed operator or installation profile', async () => {
    const create = (config: CasimirManagementConfig, profile = mvpProfile, operatorId = managementConfig.operatorId) =>
      createApp({
        db: env.db,
        token: 'synthetic-cli-bearer-token',
        operatorId,
        mvpProfile: profile,
        management: { controlOrigin, config, assets: adminAssets },
      });

    expect(() => create({ ...managementConfig, operatorId: 'user_zyxwvutsrqpo' })).toThrow(
      'Casimir management profile identity mismatch',
    );
    expect(() => create({ ...managementConfig, installationId: 'f'.repeat(32) })).toThrow(
      'Casimir management profile identity mismatch',
    );
    expect(() => create(managementConfig, { ...mvpProfile, installationId: 'f'.repeat(32) })).toThrow(
      'Casimir management profile identity mismatch',
    );
  });

  it('requires separate control and app hostnames when management sessions are enabled', () => {
    const profiles = [
      {
        ...mvpProfile,
        origins: { ...mvpProfile.origins, app: 'https://CONTROL.example.com:9443' },
      },
      {
        ...mvpProfile,
        origins: { ...mvpProfile.origins, app: 'https://control.example.com.:9443' },
      },
      {
        ...mvpProfile,
        origins: { control: 'https://127.0.0.1:8443', app: 'https://127.1:8444' },
      },
    ];

    for (const profile of profiles) {
      expect(() =>
        createApp({
          db: env.db,
          token: 'synthetic-cli-bearer-token',
          operatorId: managementConfig.operatorId,
          mvpProfile: profile,
          management: {
            controlOrigin: profile.origins.control,
            config: managementConfig,
            assets: adminAssets,
          },
        }),
      ).toThrow('Casimir management control and app origins must use separate hostnames');
    }

    const cliOnlyProfile = {
      ...mvpProfile,
      origins: { ...mvpProfile.origins, app: 'https://control.example.com:9443' },
    };
    expect(() =>
      createApp({
        db: env.db,
        token: 'synthetic-cli-bearer-token',
        operatorId: managementConfig.operatorId,
        mvpProfile: cliOnlyProfile,
      }),
    ).not.toThrow();
  });

  it('initializes and exactly replays a signed setup through the native HTTP adapter', async () => {
    const state = await mkdtemp(join(tmpdir(), 'casimir-management-http-install-'));
    const installConfig = {
      format: 1 as const,
      mode: 'loopback' as const,
      controlOrigin: 'http://127.0.0.1:4485',
      appOrigin: 'http://127.0.0.1:4486',
      bindAddress: '127.0.0.1',
      controlPort: 4485,
      appPort: 4486,
    };
    let identity: InstallIdentity | undefined;
    let seed: { operatorId: string; projectId: string } | undefined;
    let app: ReturnType<typeof createApp> | undefined;
    let server: ReturnType<typeof serve> | undefined;
    try {
      await resetC1FixtureDatabase();
      await prepareC1ControlSchemaForPGlite();
      await env.db.execute(sql`CREATE SCHEMA casimir_mvp_a`);
      const admissionSql = await readFile(
        new URL('../../../../../casimir/mvp-a/migrations/0001_admission.sql', import.meta.url),
        'utf8',
      );
      for (const statement of admissionSql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await env.db.execute(sql.raw(statement));
      }

      await initializeInstallation(
        state,
        installConfig,
        { version: 'c1.0', hash: 'f'.repeat(64) },
        async (currentIdentity) => {
          identity = currentIdentity;
          seed = await bootstrapInstallationDatabase(env.db, currentIdentity.installationId, 'c1.0');
          return seed;
        },
      );
      if (!identity || !seed) throw new Error('native_http_installation_fixture_missing');

      const owner = await prepareCasimirManagementOwner(state, identity);
      const config = await adoptCasimirManagementOwner(env.db, owner, 'c1.0', state);
      await publishCasimirManagementConfig(state, config);
      const profile = {
        ...mvpProfile,
        installationId: identity.installationId,
        origins: { control: controlOrigin, app: 'https://app.example.com:8444' },
      };
      app = createApp({
        db: env.db,
        token: identity.token,
        operatorId: config.operatorId,
        mvpProfile: profile,
        management: { controlOrigin, config, assets: adminAssets },
      });
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.once('listening', resolve);
      });

      const setupCode = randomBytes(32).toString('hex');
      const setup = {
        connections: [
          {
            configuration: {
              id: 'company',
              kind: 'oidc',
              label: 'Company SSO',
              issuer: 'https://idp.example.com',
              clientId: 'synthetic-management-client',
              allowedDomains: [],
              requiredGroups: [],
            },
            clientSecret: 'synthetic-management-client-secret',
          },
        ],
        administratorConnectionId: 'company',
        bootstrapCredentialHash: await hashLoginProof(setupCode),
        admission: { mode: 'restricted' },
        protection: null,
      };
      const body = JSON.stringify(setup);
      const signature = createHmac('sha256', config.authSetupToken)
        .update(`${PLATFORM_AUTH_SETUP_PROOF_PREFIX}\n${config.installationId}\n${body}`)
        .digest('base64url');

      const first = await postJson(server, '/internal/platform/auth-initialize', body, signature);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['content-type']).toContain('application/json');
      const firstBody = JSON.parse(first.body) as { setupPending: boolean; expiresAt: string };
      expect(Object.keys(firstBody).sort()).toEqual(['expiresAt', 'setupPending']);
      expect(firstBody.setupPending).toBe(true);
      expect(Date.parse(firstBody.expiresAt)).toBeGreaterThan(Date.now());

      const bootstrapAfterFirst = await env.db.select().from(platformAuthBootstrap);
      const settingsAfterFirst = await env.db.select().from(platformAuthSettings);
      const connectionsAfterFirst = await env.db.select().from(platformLoginConnections);
      const revisionsAfterFirst = await env.db.select().from(platformLoginRevisions);
      expect(bootstrapAfterFirst).toHaveLength(1);
      expect(bootstrapAfterFirst[0]).toMatchObject({
        installation_id: identity.installationId,
        request_hash: expect.any(String),
        credential_hash: setup.bootstrapCredentialHash,
        connection_id: 'company',
        consumed_at: null,
      });
      expect(Date.parse(bootstrapAfterFirst[0]!.expires_at)).toBe(
        Date.parse(firstBody.expiresAt),
      );
      expect(settingsAfterFirst).toHaveLength(1);
      expect(settingsAfterFirst[0]?.admission).toEqual({ mode: 'restricted' });
      expect(settingsAfterFirst[0]?.protection).toBeNull();
      expect(connectionsAfterFirst).toHaveLength(1);
      expect(connectionsAfterFirst[0]?.id).toBe('company');
      expect(revisionsAfterFirst).toHaveLength(1);
      expect(JSON.stringify(revisionsAfterFirst)).not.toContain(
        'synthetic-management-client-secret',
      );
      const usersAfterFirst = await env.db.select().from(users);
      expect(usersAfterFirst).toHaveLength(1);
      expect(usersAfterFirst[0]).toMatchObject({
        id: config.operatorId,
        role: 'admin',
        provider: 'casimir-local',
        provider_id: config.installationId,
      });

      const second = await postJson(server, '/internal/platform/auth-initialize', body, signature);
      expect(second.status).toBe(200);
      expect(second.headers['cache-control']).toBe('no-store');
      const replayBody = JSON.parse(second.body) as typeof firstBody;
      expect(replayBody.setupPending).toBe(firstBody.setupPending);
      expect(Date.parse(replayBody.expiresAt)).toBe(Date.parse(firstBody.expiresAt));
      expect(await env.db.select().from(platformAuthBootstrap)).toEqual(bootstrapAfterFirst);
      expect(await env.db.select().from(platformAuthSettings)).toEqual(settingsAfterFirst);
      expect(await env.db.select().from(platformLoginConnections)).toEqual(connectionsAfterFirst);
      expect(await env.db.select().from(platformLoginRevisions)).toEqual(revisionsAfterFirst);
      expect(await env.db.select().from(users)).toEqual(usersAfterFirst);
      const bootstrapEvents = await env.db
        .select()
        .from(operatorEvents)
        .where(eq(operatorEvents.action, 'auth.bootstrap.initialize'));
      expect(bootstrapEvents).toHaveLength(1);
    } finally {
      try {
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server!.close((error?: Error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        try {
          await app?.close();
        } finally {
          try {
            await rm(state, { recursive: true, force: true });
          } finally {
            await resetC1FixtureDatabase();
          }
        }
      }
    }
  });
});
