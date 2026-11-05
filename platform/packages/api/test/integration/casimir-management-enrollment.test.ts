import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, request as httpRequest, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { AUTH_SETUP_PROOF_PREFIX, confirmBootstrapIdentity, initializeAuthentication, stageBootstrapIdentity, verifyBootstrapCode } from '../../src/auth/bootstrap.ts';
import type { BootstrapOptions } from '../../src/auth/bootstrap.ts';
import { hmacSignState, hmacVerifyState } from '../../src/auth/hmac.ts';
import { verifyJwt } from '../../src/auth/jwt.ts';
import { randomLoginProof, hashLoginProof } from '../../src/auth/proofs.ts';
import { validateHumanSession } from '../../src/auth/sessions.ts';
import { bootstrapInstallationDatabase } from '../../src/casimir/lifecycle/bootstrap.ts';
import { beginInstallationMaintenance } from '../../src/casimir/lifecycle/maintenance.ts';
import { createFateClient } from '../../src/admin/fate/client.generated.ts';
import { projectsPageRequest } from '../../src/admin/fate/views.ts';
import { initializeInstallation, type InstallIdentity } from '../../src/casimir/lifecycle/identity.ts';
import type { CasimirManagementConfig, CasimirManagementOwner } from '../../src/casimir/management/enrollment.ts';
import { createCasimirBootstrapOptions } from '../../src/casimir/management/bootstrap-policy.ts';
import { createProject } from '../../src/db/projects.ts';
import { createUser } from '../../src/db/users.ts';
import { buildCasimirArtifact } from '../../../../../packages/void/src/cli/casimir-artifact.ts';
import { REASON_REQUESTS_EXCEEDED } from '../../src/suspension.ts';
import { deployments as deploymentRows, platformAuthBootstrap, platformAuthSettings, platformHumanSessions, platformLoginConnections, platformLoginIdentities, projects, users } from '../../src/schema.ts';
import { captureQueries, clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

const installConfig = {
  format: 1 as const,
  mode: 'loopback' as const,
  controlOrigin: 'http://127.0.0.1:4485',
  appOrigin: 'http://127.0.0.1:4486',
  bindAddress: '127.0.0.1',
  controlPort: 4485,
  appPort: 4486,
};
const bundleVersion = 'c1.1';
const bundleHash = 'c'.repeat(64);
const apiOrigin = 'https://control.management-example.test';
const issuer = 'https://idp.management-example.test';
const managementModuleUrl = new URL('../../src/casimir/management/enrollment.ts', import.meta.url);
const bootstrapPolicyUrl = new URL('../../src/casimir/management/bootstrap-policy.ts', import.meta.url);
const postgres = it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL));
const browserJourney = it.runIf(Boolean(process.env.CASIMIR_MANAGEMENT_TLS_DIR));
const artifactAdmissionEnabled = Boolean(process.env.CASIMIR_MANAGEMENT_ARTIFACT_ROOT);
const fateLifecycleOnly = process.env.CASIMIR_MANAGEMENT_FATE_LIFECYCLE_ONLY === 'true';
const authDenialsOnly = process.env.CASIMIR_MANAGEMENT_AUTH_DENIALS_ONLY === 'true';
if (authDenialsOnly && (artifactAdmissionEnabled || fateLifecycleOnly)) {
  throw new Error('management_auth_denials_profile_is_mutually_exclusive');
}
const browserJourneyTitle = artifactAdmissionEnabled
  ? 'runs original C1 setup and OIDC, then admits a native artifact and opens its manifest on a qualifying filesystem'
  : 'runs signed C1 setup and original OIDC administrator confirmation over trusted HTTPS';
const browserIssuer = 'https://idp.example.com';
const browserControlOrigin = 'https://control.example.com:8443';
const browserLogoutMode = process.env.CASIMIR_MANAGEMENT_LOGOUT_MODE === 'pointer' ? 'pointer' : 'keyboard';
const browserJourneyVariantTitle = authDenialsOnly
  ? `${browserJourneyTitle} (compiled-host auth denial boundary)`
  : fateLifecycleOnly
    ? `${browserJourneyTitle} (Fate lifecycle diagnostic)`
    : `${browserJourneyTitle} (${browserLogoutMode} logout)`;

type ManagementModule = {
  prepareCasimirManagementOwner: (state: string, identity: InstallIdentity) => Promise<CasimirManagementOwner>;
  adoptCasimirManagementOwner: (db: TestEnv['db'], owner: CasimirManagementOwner, version: string, state: string) => Promise<CasimirManagementConfig>;
  publishCasimirManagementConfig: (state: string, config: CasimirManagementConfig) => Promise<void>;
  readCasimirManagementConfig: (path: string, expectedUid?: number) => Promise<CasimirManagementConfig>;
  createCasimirBootstrapOptions: (config: CasimirManagementConfig) => BootstrapOptions;
};

async function loadManagementModule(): Promise<ManagementModule | null> {
  try {
    const [enrollment, bootstrapPolicy] = await Promise.all([
      import(managementModuleUrl.href),
      import(bootstrapPolicyUrl.href),
    ]);
    return {
      ...(enrollment as Omit<ManagementModule, 'createCasimirBootstrapOptions'>),
      createCasimirBootstrapOptions: bootstrapPolicy.createCasimirBootstrapOptions,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

async function buildFateLifecycleClient(outputRoot: string) {
  const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
  const repositoryRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
  const entry = fileURLToPath(new URL('../fixtures/casimir-fate-lifecycle-client.tsx', import.meta.url));
  const outDir = join(outputRoot, 'fate-lifecycle-client');
  let instrumentationTransforms = 0;
  const adminProvidersPath = join(repositoryRoot, 'platform/packages/api/src/admin/react/AdminProviders.tsx');
  await viteBuild({
    configFile: false,
    root: apiRoot,
    cacheDir: join(outputRoot, '.fate-lifecycle-vite-cache'),
    publicDir: false,
    plugins: [
      {
        name: 'casimir-fate-lifecycle-test-instrumentation',
        enforce: 'pre',
        transform(source, id) {
          if (id.split('?')[0]?.replaceAll('\\', '/') !== adminProvidersPath) return null;
          const anchor = '      return client;\n    },\n    hydrate: (client, snapshot) => client.hydrate(snapshot),';
          if (source.split(anchor).length !== 2) {
            throw new Error('lifecycle_instrumentation_anchor_mismatch');
          }
          instrumentationTransforms++;
          return source.replace(
            anchor,
            `      if (typeof window !== 'undefined') {
      const lifecycleInstall = Reflect.get(window, '__CASIMIR_FATE_LIFECYCLE_INSTALL__');
      if (typeof lifecycleInstall === 'function') Reflect.apply(lifecycleInstall, window, [client, session]);
      }\n${anchor}`,
          );
        },
      },
    ],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsxDev: false },
    resolve: {
      alias: {
        '@void/react/pages-client': join(repositoryRoot, 'packages/react/src/runtime/pages-client.ts'),
        '@void/react': join(repositoryRoot, 'packages/react/src/runtime/index.ts'),
        'void/pages-client': join(repositoryRoot, 'packages/void/src/pages/client.ts'),
        'void/pages-prefetch': join(repositoryRoot, 'packages/void/src/pages/prefetch.ts'),
      },
      dedupe: ['react', 'react-dom'],
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: {
        entry,
        name: 'CasimirFateLifecycleTest',
        formats: ['iife'],
        fileName: () => 'lifecycle.js',
      },
    },
  });
  if (instrumentationTransforms !== 1) {
    throw new Error(`lifecycle_instrumentation_transform_count:${instrumentationTransforms}`);
  }
  const clientPath = join(outDir, 'lifecycle.js');
  const client = await readFile(clientPath, 'utf8');
  const adminProviders = await readFile(adminProvidersPath);
  const deploymentsPage = await readFile(join(repositoryRoot, 'platform/packages/api/src/admin/react/views/DeploymentsListPage.tsx'));
  const generatedClient = await readFile(join(repositoryRoot, 'platform/packages/api/src/admin/fate/client.generated.ts'));
  const mainPath = join(repositoryRoot, 'casimir/dist/main.mjs');
  const main = await readFile(mainPath);
  const provenance = await readFile(join(repositoryRoot, 'casimir/dist/provenance.json'));
  const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  return {
    client,
    clientPath,
    manifest: {
      fixtureSha256: sha256(await readFile(entry)),
      adminProvidersSha256: sha256(adminProviders),
      deploymentsPageSha256: sha256(deploymentsPage),
      generatedClientSha256: sha256(generatedClient),
      emittedMainSha256: sha256(main),
      emittedProvenanceSha256: sha256(provenance),
      lifecycleBundleSha256: sha256(client),
      lifecycleBundleBytes: Buffer.byteLength(client),
      instrumentationTransforms,
    },
  };
}

type LifecycleGateSlot = {
  index: number;
  signature: string;
  status: number | null;
  contentType: string | null;
  error: string | null;
  ready: Promise<void>;
  delivered: Promise<void>;
  releasePromise: Promise<void>;
  release(): void;
  markReady(status: number, contentType: string | null): void;
  markError(message: string): void;
  markDelivered(): void;
};

function createLifecycleResponseGate(phase: string, maxRequests: number) {
  const requests: LifecycleGateSlot[] = [];
  let aborted = 0;
  const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  };
  return {
    phase,
    maxRequests,
    requests,
    get aborted() {
      return aborted;
    },
    register(signature: string): LifecycleGateSlot | null {
      if (requests.length >= maxRequests) {
        aborted++;
        return null;
      }
      const ready = defer();
      const delivered = defer();
      const release = defer();
      const slot: LifecycleGateSlot = {
        index: requests.length + 1,
        signature,
        status: null,
        contentType: null,
        error: null,
        ready: ready.promise,
        delivered: delivered.promise,
        releasePromise: release.promise,
        release: release.resolve,
        markReady(status, contentType) {
          slot.status = status;
          slot.contentType = contentType;
          ready.resolve();
        },
        markError(message) {
          slot.error = message;
          slot.status = 0;
          ready.resolve();
        },
        markDelivered() {
          delivered.resolve();
        },
      };
      requests.push(slot);
      return slot;
    },
    async waitForRequest(index: number, timeoutMs: number): Promise<LifecycleGateSlot | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const slot = requests[index - 1];
        if (slot?.status !== null && slot !== undefined) return slot;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    },
    releaseAll() {
      for (const slot of requests) slot.release();
    },
  };
}

let env: TestEnv;
let state: string;
let identity: InstallIdentity;
let seed: { operatorId: string; projectId: string };
let disposableArtifactRoot: string | undefined;

async function resetDatabaseFixture() {
  // C1's real installation/scope rows have FKs to public users/projects.
  // Drop only this disposable fixture's schemas before the shared API cleanup.
  await env.db.execute(sql`DROP TRIGGER IF EXISTS casimir_management_test_wait ON public.platform_auth_settings`);
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_install CASCADE`);
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_mvp_a CASCADE`);
  await env.db.execute(sql`DROP TABLE IF EXISTS public.__void_platform_installation`);
  await env.db.execute(sql`DROP FUNCTION IF EXISTS public.casimir_management_test_wait() CASCADE`);
  await env.db.execute(sql`DROP SEQUENCE IF EXISTS public.casimir_management_test_started_seq`);
  await clearTables(env.db);
}

async function applyMvpAdmissionMigration() {
  const source = await readFile(
    new URL('../../../../../casimir/mvp-a/migrations/0001_admission.sql', import.meta.url),
    'utf8',
  );
  const hash = createHash('sha256').update(source).digest('hex');
  await env.db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(1128354643, 4)`);
    await transaction.execute(sql`CREATE SCHEMA IF NOT EXISTS casimir_mvp_a`);
    await transaction.execute(sql`
      CREATE TABLE IF NOT EXISTS casimir_mvp_a.schema_migrations (
        version integer PRIMARY KEY,
        hash text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await transaction.execute<{ version: number; hash: string }>(sql`
      SELECT version, hash FROM casimir_mvp_a.schema_migrations ORDER BY version
    `);
    if (!applied.rows.length) {
      await transaction.execute(sql.raw(source));
      await transaction.execute(sql`
        INSERT INTO casimir_mvp_a.schema_migrations(version, hash) VALUES (1, ${hash})
      `);
    } else if (
      applied.rows.length !== 1 ||
      applied.rows[0]?.version !== 1 ||
      applied.rows[0]?.hash !== hash
    ) {
      throw new Error('test_mvp_migration_mismatch');
    }
  });
}

beforeAll(async () => {
  env = await setupEnv();
});

beforeEach(async () => {
  disposableArtifactRoot = undefined;
  await resetDatabaseFixture();
  await applyMvpAdmissionMigration();
  state = await mkdtemp(join(tmpdir(), 'casimir-management-enrollment-'));
  await initializeInstallation(
    state,
    installConfig,
    { version: bundleVersion, hash: bundleHash },
    async (currentIdentity) => {
      identity = currentIdentity;
      seed = await bootstrapInstallationDatabase(env.db, currentIdentity.installationId, bundleVersion);
      return seed;
    },
  );
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  if (disposableArtifactRoot) {
    await rm(disposableArtifactRoot, { recursive: true, force: true });
    disposableArtifactRoot = undefined;
  }
  await resetDatabaseFixture();
});

afterAll(async () => {
  await teardownEnv();
});

async function expectNoAuthState() {
  expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
  expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(0);
  expect(await env.db.select().from(platformHumanSessions)).toHaveLength(0);
}

async function setupInput(code: string, issuerUrl = issuer) {
  return {
    connections: [
      {
        configuration: {
          id: 'company',
          kind: 'oidc',
          label: 'Company SSO',
          issuer: issuerUrl,
          clientId: 'synthetic-management-client',
        },
        clientSecret: 'synthetic-management-client-secret',
      },
    ],
    administratorConnectionId: 'company',
    bootstrapCredentialHash: await hashLoginProof(code),
    admission: { mode: 'restricted' },
    protection: null,
  };
}

describe('durable management enrollment on an actual C1 installation', () => {
  it('adopts only the migrated C1 operator/project and publishes a separate private API configuration', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    await enrollment.publishCasimirManagementConfig(state, config);

    expect(config).toMatchObject({
      format: 1,
      installationId: identity.installationId,
      operatorId: seed.operatorId,
      projectId: seed.projectId,
    });
    expect(config.jwtSecret).not.toBe(identity.token);
    expect(config.authSetupToken).not.toBe(identity.token);
    expect(config.jwtSecret).not.toBe(config.authSetupToken);
    expect((await env.db.select().from(users)).map((user) => user.id)).toEqual([seed.operatorId]);
    expect((await env.db.select().from(projects)).map((project) => project.id)).toEqual([seed.projectId]);
    const claim = await env.db.execute<{ installation_id: string; ownership_nonce: string }>(sql`
      SELECT installation_id, ownership_nonce FROM public.__void_platform_installation WHERE singleton = true
    `);
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0]?.installation_id).toBe(identity.installationId);
    expect(claim.rows[0]?.ownership_nonce).toBe(owner.ownershipNonce);

    const persistedOwner = JSON.parse(await readFile(join(state, 'management-owner.json'), 'utf8'));
    expect(persistedOwner).toMatchObject({
      installationId: identity.installationId,
      ownershipNonce: owner.ownershipNonce,
      operatorId: seed.operatorId,
      projectId: seed.projectId,
      jwtSecret: config.jwtSecret,
      authSetupToken: config.authSetupToken,
    });
    const ownerFile = await stat(join(state, 'management-owner.json'));
    const apiFile = await stat(join(state, 'management.json'));
    expect(ownerFile.mode & 0o777).toBe(0o600);
    expect(apiFile.mode & 0o777).toBe(0o600);
    await expect(enrollment.readCasimirManagementConfig(join(state, 'management.json'))).resolves.toEqual(config);
    await expectNoAuthState();
  });

  it('recovers a lost enrollment result after the database commit without rotating secrets or ownership', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const ownerBeforeCommit = await enrollment.prepareCasimirManagementOwner(state, identity);
    const committed = await enrollment.adoptCasimirManagementOwner(env.db, ownerBeforeCommit, bundleVersion, state);
    // Simulate a process exit after the transaction commits and before the API copy is published.
    const retryOwner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const retried = await enrollment.adoptCasimirManagementOwner(env.db, retryOwner, bundleVersion, state);
    await enrollment.publishCasimirManagementConfig(state, retried);

    expect(retried.ownershipNonce).toBe(committed.ownershipNonce);
    expect(retried.jwtSecret).toBe(committed.jwtSecret);
    expect(retried.authSetupToken).toBe(committed.authSetupToken);
    expect(await env.db.select().from(users)).toHaveLength(1);
    expect(await env.db.select().from(projects)).toHaveLength(1);
  });

  it('refuses a mismatched API copy without replacing it', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const wrongCopy = { ...config, ownershipNonce: 'f'.repeat(64) };
    const path = join(state, 'management.json');
    await writeFile(path, JSON.stringify(wrongCopy), { mode: 0o600 });
    const before = createHash('sha256').update(await readFile(path)).digest('hex');

    await expect(enrollment.publishCasimirManagementConfig(state, config)).rejects.toThrow(
      'management_configuration_conflict',
    );
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before);
  });

  it('rejects API key generations that differ from the durable owner record', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const changedSecret = (value: string) => value === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const candidates: CasimirManagementConfig[] = [
      { ...config, jwtSecret: changedSecret(config.jwtSecret) },
      { ...config, authSetupToken: changedSecret(config.authSetupToken) },
      {
        ...config,
        projectSecretKeysJson: JSON.stringify({ '1': Buffer.alloc(32, 0x5a).toString('base64') }),
      },
    ];
    for (const candidate of candidates) {
      await expect(enrollment.publishCasimirManagementConfig(state, candidate)).rejects.toThrow(
        'management_configuration_conflict',
      );
    }
    await expect(readFile(join(state, 'management.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a preexisting same-installation claim without the trusted saved nonce', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    await env.db.execute(sql`
      CREATE TABLE public.__void_platform_installation (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        installation_id text NOT NULL,
        ownership_nonce text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        lifecycle_manifest jsonb
      )
    `);
    await env.db.execute(sql`
      INSERT INTO public.__void_platform_installation (singleton, installation_id, ownership_nonce)
      VALUES (true, ${identity.installationId}, 'legacy-unknown-nonce-00000000000000000000000000000000')
    `);
    const candidate = await enrollment.prepareCasimirManagementOwner(state, identity);

    await expect(
      enrollment.adoptCasimirManagementOwner(env.db, candidate, bundleVersion, state),
    ).rejects.toThrow();
    const claim = await env.db.execute<{ ownership_nonce: string }>(sql`
      SELECT ownership_nonce FROM public.__void_platform_installation WHERE singleton = true
    `);
    expect(claim.rows[0]?.ownership_nonce).toBe('legacy-unknown-nonce-00000000000000000000000000000000');
    await expectNoAuthState();
  });

  it('does not enroll over unknown existing authentication state', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    await env.db.insert(platformAuthSettings).values({ singleton: true, admission: { mode: 'restricted' } });
    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);

    await expect(
      enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state),
    ).rejects.toThrow();
    const claim = await env.db.execute<{ claim_table: string | null }>(sql`
      SELECT to_regclass('public.__void_platform_installation')::text AS claim_table
    `);
    expect(claim.rows[0]?.claim_table).toBeNull();
    expect(await env.db.select().from(platformAuthSettings)).toHaveLength(1);
  });

  it('does not enroll over an existing linked identity or human session', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    await env.db.insert(platformLoginConnections).values({ id: 'legacy', kind: 'oidc' });
    await env.db.insert(platformLoginIdentities).values({
      id: 'legacy-identity',
      user_id: seed.operatorId,
      connection_id: 'legacy',
      issuer,
      subject: 'unrecognized-existing-subject',
    });
    await env.db.insert(platformHumanSessions).values({
      id: 'legacy-session',
      user_id: seed.operatorId,
      connection_id: 'legacy',
      generation: 1,
      audience: 'admin',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);

    await expect(
      enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state),
    ).rejects.toThrow('management_existing_auth_state');
    const claim = await env.db.execute<{ claim_table: string | null }>(sql`
      SELECT to_regclass('public.__void_platform_installation')::text AS claim_table
    `);
    expect(claim.rows[0]?.claim_table).toBeNull();
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
  });

  it('keeps the durable operator/project binding fixed across retries', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const other = await createUser(
      env.db,
      'github',
      'alternate-c1-seed',
      'alternate-operator',
      'alternate@example.invalid',
      'admin',
    );
    const otherProject = await createProject(env.db, other.id, 'alternate-reference');
    await env.db.execute(sql`
      UPDATE casimir_install.installation
      SET operator_id = ${other.id}, project_id = ${otherProject.id}
      WHERE id = 1
    `);
    await env.db.execute(sql`UPDATE casimir_mvp_a.scope SET project_id = ${otherProject.id} WHERE id = 1`);

    await expect(
      enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state),
    ).rejects.toThrow('management_seed_identity_conflict');
    const persistedOwner = JSON.parse(await readFile(join(state, 'management-owner.json'), 'utf8'));
    expect(persistedOwner).toMatchObject({ operatorId: seed.operatorId, projectId: seed.projectId });
    expect(config).toMatchObject({ operatorId: seed.operatorId, projectId: seed.projectId });
  });

  it('preserves original automatic usage-suspension eligibility for the C1 seed', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    await env.db.update(users).set({ suspended_reason: REASON_REQUESTS_EXCEEDED }).where(eq(users.id, seed.operatorId));
    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    expect(config.operatorId).toBe(seed.operatorId);
  });

  it('refuses an administratively suspended C1 seed without creating ownership', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    await env.db.update(users).set({ suspended_reason: 'administrator_suspended' }).where(eq(users.id, seed.operatorId));
    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    await expect(
      enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state),
    ).rejects.toThrow('management_seed_identity_conflict');
    const claim = await env.db.execute<{ claim_table: string | null }>(sql`
      SELECT to_regclass('public.__void_platform_installation')::text AS claim_table
    `);
    expect(claim.rows[0]?.claim_table).toBeNull();
  });

  it('acquires C1 install, scope, and original lifecycle admission before auth locks, including stage and confirmation', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    await enrollment.publishCasimirManagementConfig(state, config);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_AUTH_SETUP_TOKEN: config.authSetupToken,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    const setupCode = randomLoginProof();
    const captured = await captureQueries(env.db, async () =>
      initializeAuthentication(env.db, bindings, await setupInput(setupCode), apiOrigin, options),
    );
    const queries = captured.queries.map((query) => query.toLowerCase());
    const installLock = queries.findIndex((query) => query.includes('casimir_install.installation') && query.includes('for update'));
    const scopeLock = queries.findIndex((query) => query.includes('casimir_mvp_a.scope') && query.includes('for update'));
    const lifecycleLock = queries.findIndex((query) => query.includes('void-platform-lifecycle-v1'));
    const planLock = queries.findIndex((query) => query.includes('void:platform:plans'));
    const authLock = queries.findIndex((query) => query.includes('platform_auth_settings') && query.includes('share row exclusive'));
    const usersLock = queries.findIndex((query) => query.includes('lock table') && query.includes('users'));
    expect(installLock).toBeGreaterThanOrEqual(0);
    expect(scopeLock).toBeGreaterThan(installLock);
    expect(lifecycleLock).toBeGreaterThan(scopeLock);
    expect(planLock).toBeGreaterThan(lifecycleLock);
    expect(authLock).toBeGreaterThan(planLock);
    expect(usersLock).toBeGreaterThan(authLock);

    const pending = await verifyBootstrapCode(env.db, config.installationId, setupCode);
    const identityResult = {
      issuer,
      subject: 'synthetic-management-owner',
      login: 'mutable-display-name',
      email: 'management@example.invalid',
      emailVerified: true,
      groups: [],
    };
    const proof = await stageBootstrapIdentity(env.db, {
      installationId: config.installationId,
      credentialHash: pending.credential_hash,
      connectionId: pending.connection_id,
      revision: 1,
      generation: 1,
      identity: identityResult,
    }, options);
    const confirmed = await confirmBootstrapIdentity(env.db, bindings, proof, undefined, options);
    expect(confirmed.session.user_id).toBe(seed.operatorId);
    expect(confirmed.token).toBeTruthy();
    expect(await validateHumanSession(env.db, { sub: seed.operatorId, aud: 'admin', sid: confirmed.session.id })).toBeTruthy();
    expect(await env.db.select().from(users)).toHaveLength(1);
  });

  postgres('serializes real C1 maintenance against bootstrap admission on PostgreSQL', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    await env.db.execute(sql`CREATE SEQUENCE public.casimir_management_test_started_seq START WITH 1`);
    await env.db.execute(sql`
      CREATE FUNCTION public.casimir_management_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('public.casimir_management_test_started_seq');
        PERFORM pg_sleep(0.5);
        RETURN NEW;
      END;
      $$
    `);
    await env.db.execute(sql`
      CREATE TRIGGER casimir_management_test_wait BEFORE INSERT ON casimir_install.maintenance
      FOR EACH ROW EXECUTE FUNCTION public.casimir_management_test_wait()
    `);

    const maintenance = beginInstallationMaintenance(env.db, config.installationId, 'backup', bundleVersion);
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const sequence = await env.db.execute<{ is_called: boolean }>(sql`
        SELECT is_called FROM public.casimir_management_test_started_seq
      `);
      if (sequence.rows[0]?.is_called) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(true);
    const setup = initializeAuthentication(env.db, bindings, await setupInput(randomLoginProof()), apiOrigin, options);

    await maintenance;
    await expect(setup).rejects.toMatchObject({ code: 'management_installation_unavailable' });
    await expectNoAuthState();
  });

  it('denies identity staging after C1 maintenance starts without changing the pending setup', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    const setupCode = randomLoginProof();
    await initializeAuthentication(env.db, bindings, await setupInput(setupCode), apiOrigin, options);
    const pending = await verifyBootstrapCode(env.db, config.installationId, setupCode);
    const before = (await env.db.select().from(platformAuthBootstrap))[0];
    expect(before?.pending_identity).toBeNull();

    await beginInstallationMaintenance(env.db, config.installationId, 'backup', bundleVersion);
    await expect(stageBootstrapIdentity(env.db, {
      installationId: config.installationId,
      credentialHash: pending.credential_hash,
      connectionId: pending.connection_id,
      revision: 1,
      generation: 1,
      identity: {
        issuer,
        subject: 'maintenance-denied-stage',
        login: 'maintenance-stage',
        email: 'stage@example.invalid',
        emailVerified: true,
        groups: [],
      },
    }, options)).rejects.toMatchObject({ code: 'management_installation_unavailable' });
    const after = (await env.db.select().from(platformAuthBootstrap))[0];
    expect(after?.pending_identity).toEqual(before?.pending_identity);
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(0);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(0);
    expect(await env.db.select().from(users)).toHaveLength(1);
  });

  it('denies identity confirmation after C1 maintenance starts without linking or minting a session', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_AUTH_SETUP_TOKEN: config.authSetupToken,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    const setupCode = randomLoginProof();
    await initializeAuthentication(env.db, bindings, await setupInput(setupCode), apiOrigin, options);
    const pending = await verifyBootstrapCode(env.db, config.installationId, setupCode);
    const identityResult = {
      issuer,
      subject: 'maintenance-denied-confirm',
      login: 'maintenance-confirm',
      email: 'confirm@example.invalid',
      emailVerified: true,
      groups: [],
    };
    const proof = await stageBootstrapIdentity(env.db, {
      installationId: config.installationId,
      credentialHash: pending.credential_hash,
      connectionId: pending.connection_id,
      revision: 1,
      generation: 1,
      identity: identityResult,
    }, options);
    const before = (await env.db.select().from(platformAuthBootstrap))[0];

    await beginInstallationMaintenance(env.db, config.installationId, 'backup', bundleVersion);
    await expect(confirmBootstrapIdentity(env.db, bindings, proof, undefined, options)).rejects.toMatchObject({
      code: 'management_installation_unavailable',
    });
    const after = (await env.db.select().from(platformAuthBootstrap))[0];
    expect(after?.pending_identity).toEqual(before?.pending_identity);
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(0);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(0);
    expect(await env.db.select().from(users)).toHaveLength(1);
  });

  postgres('makes maintenance wait when authentication admission locks C1 first', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    await env.db.execute(sql`CREATE SEQUENCE public.casimir_management_test_started_seq START WITH 1`);
    await env.db.execute(sql`
      CREATE FUNCTION public.casimir_management_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('public.casimir_management_test_started_seq');
        PERFORM pg_sleep(1);
        RETURN NEW;
      END;
      $$
    `);
    await env.db.execute(sql`
      CREATE TRIGGER casimir_management_test_wait BEFORE INSERT ON public.platform_auth_settings
      FOR EACH ROW EXECUTE FUNCTION public.casimir_management_test_wait()
    `);

    const setup = initializeAuthentication(
      env.db,
      bindings,
      await setupInput(randomLoginProof()),
      apiOrigin,
      options,
    );
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const sequence = await env.db.execute<{ is_called: boolean }>(sql`
        SELECT is_called FROM public.casimir_management_test_started_seq
      `);
      if (sequence.rows[0]?.is_called) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(true);
    const maintenance = beginInstallationMaintenance(env.db, config.installationId, 'backup', bundleVersion);
    let observedAdmissionWait = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const waiters = await env.db.execute<{ waiting: number }>(sql`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%FROM casimir_install.installation%'
          AND pid <> pg_backend_pid()
      `);
      if ((waiters.rows[0]?.waiting ?? 0) > 0) {
        observedAdmissionWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const setupResult = await setup;
    const maintenanceResult = await maintenance;
    expect(observedAdmissionWait).toBe(true);
    expect(setupResult.setupPending).toBe(true);
    expect(maintenanceResult.phase).toBe('requested');
  });

  postgres('fails lifecycle admission before claim-row locking so the original checkpoint can proceed', async () => {
    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;

    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    const options = enrollment.createCasimirBootstrapOptions(config);
    const bindings = {
      ...env,
      JWT_SECRET: config.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
      PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
      PLATFORM_AUTH_SETUP_TOKEN: config.authSetupToken,
      PLATFORM_INSTALLATION_ID: config.installationId,
    } as unknown as Parameters<typeof initializeAuthentication>[1];
    const pool = env.db.$client as pg.Pool;
    const lifecycle = await pool.connect();
    const pendingOperations: Array<Promise<unknown>> = [];
    const lifecycleKey = `void-platform-lifecycle-v1:${config.installationId}:${config.ownershipNonce}`;
    let lifecycleHeld = false;

    const outcomeWithin = async <T>(operation: Promise<T>) => {
      const settled = operation.then(
        (value) => ({ kind: 'fulfilled' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      pendingOperations.push(settled);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), 750);
      });
      try {
        return await Promise.race([settled, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const checkpointClaim = async () => {
      const checkpoint = await pool.connect();
      try {
        await checkpoint.query('BEGIN');
        await checkpoint.query("SET LOCAL statement_timeout = '1000ms'");
        const result = await checkpoint.query(
          `UPDATE public.__void_platform_installation
           SET claimed_at = claimed_at
           WHERE singleton = true AND installation_id = $1`,
          [config.installationId],
        );
        expect(result.rowCount).toBe(1);
        await checkpoint.query('COMMIT');
      } catch (error) {
        await checkpoint.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        checkpoint.release();
      }
    };

    try {
      await lifecycle.query(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [lifecycleKey],
      );
      lifecycleHeld = true;

      const adoption = await outcomeWithin(
        enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state),
      );
      expect(adoption.kind).toBe('rejected');
      if (adoption.kind === 'rejected') {
        expect(adoption.error).toMatchObject({ message: 'lifecycle_busy' });
      }
      await checkpointClaim();

      const admission = await outcomeWithin(
        initializeAuthentication(
          env.db,
          bindings,
          await setupInput(randomLoginProof()),
          apiOrigin,
          options,
        ),
      );
      expect(admission.kind).toBe('rejected');
      if (admission.kind === 'rejected') {
        expect(admission.error).toMatchObject({ code: 'lifecycle_busy' });
      }
      await checkpointClaim();
      await expectNoAuthState();
    } finally {
      if (lifecycleHeld) {
        await lifecycle.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lifecycleKey]);
      }
      lifecycle.release();
      await Promise.all(pendingOperations);
    }
  });

  browserJourney(browserJourneyVariantTitle, async () => {
    const tlsDirectory = process.env.CASIMIR_MANAGEMENT_TLS_DIR;
    if (!tlsDirectory) throw new Error('management_browser_tls_fixture_required');
    const caPath = join(tlsDirectory, 'ca.crt');
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(caPath);
    const caCertificate = await readFile(caPath);
    const tlsOptions = {
      key: await readFile(join(tlsDirectory, 'server.key')),
      cert: await readFile(join(tlsDirectory, 'server.crt')),
    };
    const nssDatabase = join(homedir(), '.pki', 'nssdb');
    await mkdir(nssDatabase, { recursive: true });
    if (!existsSync(join(nssDatabase, 'cert9.db'))) {
      const initialized = spawnSync(
        'certutil',
        ['-N', '-d', `sql:${nssDatabase}`, '--empty-password'],
        { encoding: 'utf8' },
      );
      if (initialized.status !== 0) {
        throw new Error(`certutil NSS initialization failed: ${initialized.stderr}`);
      }
    }
    const trustName = `casimir-management-${createHash('sha256').update(caCertificate).digest('hex').slice(0, 16)}`;
    spawnSync('certutil', ['-D', '-d', `sql:${nssDatabase}`, '-n', trustName], { encoding: 'utf8' });
    const trusted = spawnSync(
      'certutil',
      ['-A', '-d', `sql:${nssDatabase}`, '-n', trustName, '-t', 'C,,', '-i', caPath],
      { encoding: 'utf8' },
    );
    if (trusted.status !== 0) throw new Error(`certutil CA import failed: ${trusted.stderr}`);

    const enrollment = await loadManagementModule();
    expect(enrollment).not.toBeNull();
    if (!enrollment) return;
    const owner = await enrollment.prepareCasimirManagementOwner(state, identity);
    const config = await enrollment.adoptCasimirManagementOwner(env.db, owner, bundleVersion, state);
    await enrollment.publishCasimirManagementConfig(state, config);
    const secondaryProject = await createProject(env.db, config.operatorId, 'casimir-secondary');
    const bootstrapOptions = createCasimirBootstrapOptions(config);
    const setupCode = randomLoginProof();
    const setup = await setupInput(setupCode, browserIssuer);
    const setupBody = JSON.stringify(setup);
    const setupSignature = await hmacSignState(
      `${AUTH_SETUP_PROOF_PREFIX}\n${config.installationId}\n${setupBody}`,
      config.authSetupToken,
    );
    let artifactRoot = '/tmp/casimir-management-browser';
    if (artifactAdmissionEnabled) {
      const configuredRoot = process.env.CASIMIR_MANAGEMENT_ARTIFACT_ROOT;
      if (!configuredRoot) throw new Error('management_artifact_capacity_root_required');
      // Keep this on the runner's real capacity fixture; production statfs guards stay active.
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      disposableArtifactRoot = await mkdtemp(join(configuredRoot, 'casimir-management-artifact-'));
      artifactRoot = disposableArtifactRoot;
    }
    const profile = {
      runtime: {
        protocol: 1 as const,
        profile: 'node-sqlite-v1' as const,
        sdkVersion: '1.1.11',
        runtimeId: 'e'.repeat(64),
        platform: 'linux/amd64' as const,
        nodeAbi: '137',
      },
      artifactRoot,
      installationId: config.installationId,
      origins: { control: browserControlOrigin, app: 'https://app.example.com:8444' },
    };
    const profilePath = join(state, 'mvp-profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const keyPair = await generateKeyPair('ES256', { extractable: true });
    const jwk = {
      ...(await exportJWK(keyPair.publicKey)),
      alg: 'ES256',
      kid: 'casimir-management-browser-key',
      use: 'sig',
    };
    let authorization: URL | undefined;
    let discoveryRequests = 0;
    let authorizationRequests = 0;
    let tokenRequests = 0;
    let keyRequests = 0;
    let providerFailure: unknown;

    const json = (response: ServerResponse, value: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const idp = createHttpsServer(tlsOptions, (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', browserIssuer);
        if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
          discoveryRequests++;
          json(response, {
            issuer: browserIssuer,
            authorization_endpoint: `${browserIssuer}/authorize`,
            token_endpoint: `${browserIssuer}/token`,
            jwks_uri: `${browserIssuer}/keys`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['ES256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/authorize') {
          authorizationRequests++;
          if (
            url.searchParams.get('client_id') !== 'synthetic-management-client' ||
            url.searchParams.get('response_type') !== 'code' ||
            url.searchParams.get('code_challenge_method') !== 'S256' ||
            url.searchParams.get('scope')?.split(' ').includes('openid') !== true
          ) {
            response.writeHead(400).end('invalid authorization request');
            return;
          }
          authorization = url;
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('<h1>Local identity provider</h1><form method="post" action="/approve"><button type="submit">Sign in as test owner</button></form>');
          return;
        }
        if (request.method === 'POST' && url.pathname === '/approve' && authorization) {
          const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
          callback.searchParams.set('code', 'casimir-management-code');
          callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
          response.writeHead(302, { Location: callback.href, 'Cache-Control': 'no-store' }).end();
          return;
        }
        if (request.method === 'POST' && url.pathname === '/token') {
          const chunks: Array<Buffer> = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const parameters = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const verifier = parameters.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !authorization ||
            parameters.get('code') !== 'casimir-management-code' ||
            parameters.get('client_id') !== 'synthetic-management-client' ||
            parameters.get('client_secret') !== 'synthetic-management-client-secret' ||
            parameters.get('redirect_uri') !== `${browserControlOrigin}/auth/callback` ||
            challenge !== authorization.searchParams.get('code_challenge')
          ) {
            response.writeHead(400).end('invalid token request');
            return;
          }
          tokenRequests++;
          const idToken = await new SignJWT({
            nonce: authorization.searchParams.get('nonce'),
            email: 'owner@example.com',
            email_verified: true,
            preferred_username: 'casimir-owner',
          })
            .setIssuer(browserIssuer)
            .setAudience('synthetic-management-client')
            .setSubject('casimir-owner-subject')
            .setIssuedAt()
            .setExpirationTime('5m')
            .setProtectedHeader({ alg: 'ES256', kid: 'casimir-management-browser-key' })
            .sign(keyPair.privateKey);
          json(response, { token_type: 'Bearer', access_token: 'local-test-token', id_token: idToken });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/keys') {
          keyRequests++;
          json(response, { keys: [jwk] });
          return;
        }
        response.writeHead(404).end('not found');
      })().catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500).end('identity fixture failed');
      });
    });

    const backendPortProbe = createHttpServer();
    await new Promise<void>((resolve) => backendPortProbe.listen(0, '127.0.0.1', resolve));
    const backendAddress = backendPortProbe.address();
    if (!backendAddress || typeof backendAddress === 'string') {
      throw new Error('compiled_main_port_unavailable');
    }
    const backendPort = backendAddress.port;
    await new Promise<void>((resolve, reject) =>
      backendPortProbe.close((error?: Error) => (error ? reject(error) : resolve())),
    );
    const control = createHttpsServer(tlsOptions, (incoming, outgoing) => {
      const proxy = httpRequest(
        {
          hostname: '127.0.0.1',
          port: backendPort,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (upstream) => {
          const headers = { ...upstream.headers };
          delete headers.connection;
          outgoing.writeHead(upstream.statusCode ?? 502, headers);
          upstream.pipe(outgoing);
        },
      );
      proxy.on('error', (error) => {
        if (!outgoing.headersSent) outgoing.writeHead(502).end('Casimir backend unavailable');
        else outgoing.destroy(error);
      });
      incoming.pipe(proxy);
    });
    const listen = (server: typeof idp, port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let compiledMain: ReturnType<typeof spawn> | undefined;
    let controlListening = false;
    let idpListening = false;
    let mainOutput = '';
    let browserEvidenceFinalizer: ((outcome: { status: 'passed' | 'failed'; errorName?: string }) => Promise<void>) | undefined;
    let browserEvidenceStatus: 'passed' | 'failed' = 'failed';
    let browserEvidenceErrorName: string | undefined;
    let lifecycleGate: ReturnType<typeof createLifecycleResponseGate> | null = null;
    let lifecycleEvidence: Record<string, unknown> | null = null;
    let lifecycleBuildManifest: Record<string, unknown> | null = null;
    let authDenialEvidence: Record<string, unknown> | null = null;
    try {
      compiledMain = spawn(process.execPath, ['casimir/dist/main.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: process.env.VOID_TEST_DATABASE_URL,
          CASIMIR_TOKEN: identity.token,
          CASIMIR_OPERATOR_ID: config.operatorId,
          PORT: String(backendPort),
          CASIMIR_MVP_PROFILE: profilePath,
          CASIMIR_MANAGEMENT_CONFIG: join(state, 'management.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      compiledMain.stdout?.on('data', (chunk: Buffer | string) => {
        mainOutput += chunk.toString();
      });
      compiledMain.stderr?.on('data', (chunk: Buffer | string) => {
        mainOutput += chunk.toString();
      });
      let backendReady = false;
      for (let attempt = 0; attempt < 50 && !backendReady; attempt++) {
        if (compiledMain.exitCode !== null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${backendPort}/health`);
          backendReady = response.status === 200;
          if (!backendReady) await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!backendReady) throw new Error(`compiled_main_not_ready:${mainOutput}`);
      await listen(idp, 443);
      idpListening = true;
      await listen(control, 8443);
      controlListening = true;
      await fetch(`${browserControlOrigin}/internal/platform/auth-initialize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Void-Auth-Setup': setupSignature,
        },
        body: setupBody,
      }).then(async (response) => {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ setupPending: true });
      });
      browser = await chromium.launch();
      const page = await browser.newPage();
      const assetResponses = new Map<string, number>();
      const browserErrors: Array<string> = [];
      const browserConsoleErrors: Array<{ type: string; message: string }> = [];
      const failedBrowserRequests: Array<{ method: string; path: string; error: string }> = [];
      const lifecycleFixtureResponses: Array<{ path: string; status: number; contentType: string | null }> = [];
      const fateRequestBodies: Array<string> = [];
      const managementResponses: Array<{
        method: string;
        path: string;
        status: number;
        cacheControl: string | null;
        vary: string | null;
        contentType: string | null;
        xVoidPages: string | null;
      }> = [];
      type FateGroup = {
        phase: string;
        signature: string;
        requestSummary: Array<Record<string, unknown>>;
        requests: number;
        aborted: number;
        responses: Array<Record<string, unknown>>;
      };
      const maxIdenticalFateRequests = 12;
      const maxTotalFateRequests = 96;
      const fateGroups = new Map<string, FateGroup>();
      const fateSignatureCounts = new Map<string, number>();
      const fateGroupByWireHash = new Map<string, FateGroup>();
      const fateResponseTasks: Array<Promise<void>> = [];
      let fateRequestTotal = 0;
      let fateRequestCap: { phase: string; signature: string; identicalCount: number; totalCount: number } | null = null;
      let pageClosingForFateCap = false;
      let fateDiagnosticsPrinted = false;
      let browserPhase = 'setup';
      let deploymentCompleteness: Record<string, unknown> | null = null;
      let deploymentSteadyObservation: Record<string, unknown> | null = null;
      const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
      const safeDiagnosticText = (message: string) =>
        message
          .replace(/\b(code|state|nonce|token|secret|proof|authorization)=([^&\s]+)/gi, '$1=[redacted]')
          .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted-jwt]')
          .replace(/https?:\/\/[^\s)]+/g, (value) => {
            try {
              const url = new URL(value);
              return `${url.origin}${url.pathname}`;
            } catch {
              return '[redacted-url]';
            }
          })
          .slice(0, 500);
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value);
      const fieldPaths = (value: unknown, prefix = ''): Array<string> => {
        if (value === true) return prefix ? [prefix] : [];
        if (typeof value === 'string') return [prefix ? `${prefix}:${value}` : value];
        if (Array.isArray(value)) return value.flatMap((item) => fieldPaths(item, prefix));
        if (!isRecord(value)) return [];
        return Object.entries(value).flatMap(([key, child]) => {
          const path = prefix ? `${prefix}.${key}` : key;
          return child === true ? [path] : fieldPaths(child, path);
        });
      };
      const requestSummary = (body: string) => {
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(body);
          if (isRecord(value)) parsed = value;
        } catch {
          // Keep only a hash for unexpected encodings.
        }
        const operations = Array.isArray(parsed.operations) ? parsed.operations.filter(isRecord) : [];
        const normalized = operations.map((operation) =>
          Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'id')),
        );
        const signature = digest(JSON.stringify(normalized.length ? normalized : body));
        const summary = operations.map((operation) => {
          const args = isRecord(operation.args) ? operation.args : {};
          const rawPath = typeof args.path === 'string' ? args.path : undefined;
          let path: string | undefined;
          if (rawPath) {
            try {
              const url = new URL(rawPath, 'https://admin.invalid');
              if (url.origin === 'https://admin.invalid' && url.pathname.startsWith('/admin/')) {
                path = `${url.pathname}${url.searchParams.has('search') ? '?search=[redacted]' : ''}`;
              }
            } catch {
              path = '[invalid-path]';
            }
          }
          return {
            ...(typeof operation.kind === 'string' ? { kind: operation.kind } : {}),
            ...(typeof operation.name === 'string' ? { name: operation.name } : {}),
            ...(typeof operation.type === 'string' ? { type: operation.type } : {}),
            keys: Object.keys(operation)
              .filter((key) => key !== 'id' && !/token|cookie|secret|proof|password|nonce|authorization/i.test(key))
              .sort(),
            argsKeys: Object.keys(args)
              .filter((key) => !/token|cookie|secret|proof|password|nonce|authorization/i.test(key))
              .sort(),
            ...(path ? { path } : {}),
            selectedFields: fieldPaths(operation.select)
              .filter((field) => !/token|cookie|secret|proof|password|nonce|authorization/i.test(field))
              .slice(0, 80)
              .sort(),
          };
        });
        return { signature, summary };
      };
      const responseShape = (body: string) => {
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          return { kind: 'non-json', bytes: Buffer.byteLength(body) };
        }
        const fields = new Set<string>();
        const timezoneTypes: Record<string, number> = {};
        let nodes = 0;
        const visit = (current: unknown, prefix = '', depth = 0): void => {
          if (!isRecord(current) && !Array.isArray(current)) return;
          if (++nodes > 1_000 || depth > 5) return;
          if (Array.isArray(current)) {
            current.slice(0, 4).forEach((item) => visit(item, prefix, depth + 1));
            return;
          }
          for (const [key, child] of Object.entries(current)) {
            if (/token|cookie|secret|proof|password|nonce|authorization/i.test(key)) continue;
            const field = prefix ? `${prefix}.${key}` : key;
            fields.add(field);
            if (key === 'tz') {
              const type = child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child;
              timezoneTypes[type] = (timezoneTypes[type] ?? 0) + 1;
            }
            visit(child, field, depth + 1);
          }
        };
        visit(value);
        return {
          rootKeys: isRecord(value)
            ? Object.keys(value).filter((key) => !/token|cookie|secret|proof|password|nonce|authorization/i.test(key)).sort()
            : [],
          fields: [...fields].sort().slice(0, 120),
          timezoneTypes,
        };
      };
      const diagnostics = () => ({
        totalFateRequests: fateRequestTotal,
        cap: fateRequestCap,
        fateGroups: [...fateGroups.values()],
        responseCounts: Object.fromEntries(
          [...new Set(managementResponses.map((response) => `${response.method} ${response.path} ${response.status}`))]
            .map((key) => [key, managementResponses.filter((response) => `${response.method} ${response.path} ${response.status}` === key).length]),
        ),
        browserConsoleErrors,
        browserErrors: browserErrors.map(safeDiagnosticText),
        failedBrowserRequests,
      });
      const phaseCounts = () =>
        [...fateGroups.values()].reduce<Record<string, { requests: number; aborted: number; groups: number }>>(
          (counts, group) => {
            const count = (counts[group.phase] ??= { requests: 0, aborted: 0, groups: 0 });
            count.requests += group.requests;
            count.aborted += group.aborted;
            count.groups++;
            return counts;
          },
          {},
        );
      const settleFateResponses = async () => {
        let settled = 0;
        while (settled < fateResponseTasks.length) {
          const pending = fateResponseTasks.slice(settled);
          settled = fateResponseTasks.length;
          await Promise.allSettled(pending);
        }
      };
      const resultPath = process.env.CASIMIR_MANAGEMENT_RESULT_PATH;
      browserEvidenceFinalizer = async (outcome) => {
        await settleFateResponses();
        if (!resultPath) return;
        const result = {
          format: 1,
          test: authDenialsOnly
            ? 'compiled-host management authentication denial boundary'
            : 'original C1 management OIDC browser journey',
          logoutMode: browserLogoutMode,
          status: outcome.status,
          ...(outcome.errorName ? { errorName: outcome.errorName } : {}),
          authDenialEvidence,
          fateLifecycleInitialSuspense: lifecycleBuildManifest
            ? {
                build: lifecycleBuildManifest,
                fixtureResponses: lifecycleFixtureResponses,
                ...(lifecycleEvidence ?? { evidence: null }),
              }
            : null,
          phaseCounts: phaseCounts(),
          totalFateRequests: fateRequestTotal,
          requestCaps: {
            identicalSignature: maxIdenticalFateRequests,
            total: maxTotalFateRequests,
            reached: fateRequestCap,
          },
          deployments: deploymentCompleteness
            ? {
                ...deploymentCompleteness,
                steadyObservation: deploymentSteadyObservation,
              }
            : null,
          fateGroups: [...fateGroups.values()],
          responseCounts: diagnostics().responseCounts,
          browserConsoleErrors,
          browserErrors: browserErrors.map(safeDiagnosticText),
          failedBrowserRequests,
        };
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      };
      const printDiagnostics = (label: string, extra: Record<string, unknown> = {}) => {
        if (!fateDiagnosticsPrinted) {
          fateDiagnosticsPrinted = true;
          console.error(`[${label}] ${JSON.stringify({ ...diagnostics(), ...extra })}`);
        }
      };
      let adminLandingStatus: number | undefined;
      page.on('response', (response) => {
        const responseUrl = new URL(response.url());
        const pathname = responseUrl.pathname;
        if (
          responseUrl.origin === browserControlOrigin &&
          (pathname === '/__test/fate-lifecycle' || pathname === '/__test/fate-lifecycle-client.js')
        ) {
          lifecycleFixtureResponses.push({
            path: pathname,
            status: response.status(),
            contentType: response.headers()['content-type'] ?? null,
          });
        }
        if (responseUrl.origin === browserControlOrigin && pathname.startsWith('/admin/')) {
          const headers = response.headers();
          managementResponses.push({
            method: response.request().method(),
            path: pathname,
            status: response.status(),
            cacheControl: headers['cache-control'] ?? null,
            vary: headers.vary ?? null,
            contentType: headers['content-type'] ?? null,
            xVoidPages: headers['x-voidpages'] ?? null,
          });
        }
        if (pathname === '/admin/' && response.request().resourceType() === 'document') {
          adminLandingStatus = response.status();
        }
        if (pathname === '/admin/client.js' || pathname === '/admin/style.css') {
          assetResponses.set(pathname, response.status());
        }
        if (new URL(response.url()).origin === browserControlOrigin && pathname === '/admin/fate') {
          const bodyHash = digest(response.request().postData() ?? '');
          const group = fateGroupByWireHash.get(bodyHash);
          if (group) {
            const task = (async () => {
              const body = await response.text();
              const headers = response.headers();
              group.responses.push({
                status: response.status(),
                cacheControl: headers['cache-control'] ?? null,
                vary: headers.vary ?? null,
                contentType: headers['content-type'] ?? null,
                xVoidPages: headers['x-voidpages'] ?? null,
                age: headers.age ?? null,
                etag: headers.etag ?? null,
                xCache: headers['x-cache'] ?? null,
                bodyBytes: Buffer.byteLength(body),
                bodyShape: responseShape(body),
              });
            })().catch((error: unknown) => {
              failedBrowserRequests.push({
                method: response.request().method(),
                path: '/admin/fate',
                error: safeDiagnosticText(error instanceof Error ? error.message : String(error)),
              });
            });
            fateResponseTasks.push(task);
          }
        }
      });
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/admin/fate') {
          fateRequestBodies.push(request.postData() ?? '');
        }
      });
      page.on('pageerror', (error) => browserErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          browserConsoleErrors.push({ type: message.type(), message: safeDiagnosticText(message.text()) });
        }
      });
      page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        if (url.origin === browserControlOrigin && url.pathname.startsWith('/admin/')) {
          failedBrowserRequests.push({
            method: request.method(),
            path: url.pathname,
            error: safeDiagnosticText(request.failure()?.errorText ?? 'unknown'),
          });
        }
      });
      await page.route('**/admin/fate', async (route) => {
        const body = route.request().postData() ?? '';
        const { signature, summary } = requestSummary(body);
        fateRequestTotal++;
        const signatureCount = (fateSignatureCounts.get(signature) ?? 0) + 1;
        fateSignatureCounts.set(signature, signatureCount);
        const groupKey = `${browserPhase}:${signature}`;
        let group = fateGroups.get(groupKey);
        if (!group) {
          group = { phase: browserPhase, signature, requestSummary: summary, requests: 0, aborted: 0, responses: [] };
          fateGroups.set(groupKey, group);
        }
        group.requests++;
        fateGroupByWireHash.set(digest(body), group);
        if (fateRequestCap || signatureCount > maxIdenticalFateRequests || fateRequestTotal > maxTotalFateRequests) {
          group.aborted++;
          const firstCap = fateRequestCap === null;
          fateRequestCap ??= {
            phase: browserPhase,
            signature,
            identicalCount: signatureCount,
            totalCount: fateRequestTotal,
          };
          await route.abort('blockedbyclient').catch(() => {});
          if (firstCap && !pageClosingForFateCap) {
            pageClosingForFateCap = true;
            await Promise.allSettled(fateResponseTasks);
            await page.close().catch(() => {});
            printDiagnostics('management fate request cap');
          }
          return;
        }
        const lifecycleRequest = summary.some((operation) => operation.name === 'deploymentsPage');
        if (lifecycleGate && lifecycleRequest) {
          const gate = lifecycleGate;
          const slot = gate.register(signature);
          if (!slot) {
            await route.abort('blockedbyclient').catch(() => {});
            return;
          }
          try {
            const upstream = await route.fetch({ timeout: 8_000 });
            slot.markReady(upstream.status(), upstream.headers()['content-type'] ?? null);
            await slot.releasePromise;
            await route.fulfill({ response: upstream });
          } catch (error) {
            slot.markError(safeDiagnosticText(error instanceof Error ? error.message : String(error)));
            await route.abort('failed').catch(() => {});
          } finally {
            slot.markDelivered();
          }
          return;
        }
        await route.continue();
      });
      await page.goto(`${browserControlOrigin}/admin/login`);
      await page.waitForURL(`${browserControlOrigin}/setup`);
      await page.getByLabel('Setup code').fill(setupCode);
      await Promise.all([
        page.waitForURL((url) => url.origin === browserIssuer && url.pathname === '/authorize'),
        page.getByRole('button', { name: 'Continue with Company SSO' }).click(),
      ]);
      await page.getByRole('button', { name: 'Sign in as test owner' }).click();
      await page.getByRole('heading', { name: 'Confirm the first administrator' }).waitFor();
      expect(await page.getByText('casimir-owner', { exact: true }).count()).toBe(1);
      expect(await page.getByText('casimir-owner-subject', { exact: true }).count()).toBe(1);
      expect(await env.db.select().from(users)).toHaveLength(1);
      browserPhase = 'dashboard-entry';
      await Promise.all([
        page.waitForURL(`${browserControlOrigin}/admin/`),
        page.getByRole('button', { name: 'Make this account the platform administrator' }).click(),
      ]);
      expect(adminLandingStatus).toBe(200);
      expect(await page.getByRole('heading', { name: 'Dashboard', exact: true }).count()).toBe(1);
      const bootstrapStateAfterConfirmation = await env.db.select().from(platformAuthBootstrap);
      expect(bootstrapStateAfterConfirmation).toHaveLength(1);
      expect(bootstrapStateAfterConfirmation[0]?.consumed_at).toBeTruthy();
      expect(bootstrapStateAfterConfirmation[0]?.claim_hash).toBeNull();
      expect(bootstrapStateAfterConfirmation[0]?.pending_identity).toBeNull();
      expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
      const authSettingsAfterConfirmation = await env.db.select().from(platformAuthSettings);
      expect(authSettingsAfterConfirmation).toHaveLength(1);
      await page.waitForLoadState('networkidle');
      await page.getByText('Traffic metrics are unavailable for this installation.', { exact: true }).waitFor();
      await page.locator('#health-checks li[aria-label="Proxy: Unavailable"]').waitFor();
      expect(await page.locator('#health-checks li[aria-label="API: Healthy"]').count()).toBe(1);
      const apiHealthTitle = await page
        .locator('#health-checks li[aria-label="API: Healthy"]')
        .getAttribute('title');
      expect(apiHealthTitle).toMatch(/^API: Healthy \(\d+(?:\.\d+)?ms\)$/);
      expect(await page.locator('#health-checks li[aria-label="Database: Healthy"]').count()).toBe(1);
      expect(await page.locator('#health-checks li[aria-label="Dispatch: Unavailable"]').count()).toBe(1);

      const dashboardMetrics = page.locator('.void-admin-metrics .void-admin-card');
      expect(await dashboardMetrics.count()).toBe(3);
      const [dashboardUsers, dashboardProjects, dashboardDeployments] = await Promise.all([
        env.db.select().from(users),
        env.db.select().from(projects),
        env.db.select().from(deploymentRows),
      ]);
      expect(await dashboardMetrics.nth(0).textContent()).toContain(String(dashboardUsers.length));
      expect(await dashboardMetrics.nth(1).textContent()).toContain(String(dashboardProjects.length));
      expect(await dashboardMetrics.nth(2).textContent()).toContain(String(dashboardDeployments.length));
      const dashboardSeedProject = dashboardProjects.find((project) => project.id === seed.projectId);
      if (!dashboardSeedProject) throw new Error('C1 seed project missing from dashboard fixture');
      const dashboardSeedRow = page
        .locator('.void-admin-projects-table tr')
        .filter({ hasText: dashboardSeedProject.slug });
      expect(await dashboardSeedRow.getByRole('link', { name: dashboardSeedProject.slug, exact: true }).count()).toBe(1);
      expect(await dashboardSeedRow.locator('.void-admin-url').getAttribute('href')).toBe(
        'https://app.example.com:8444',
      );

      const administratorCookie = (await page.context().cookies(browserControlOrigin)).find(
        (cookie) => cookie.name === 'admin_token',
      );
      expect(administratorCookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
      });
      if (!administratorCookie) throw new Error('administrator_cookie_missing');
      const persistedAdmin = (await env.db.select().from(users)).find(
        (user) => user.id === seed.operatorId,
      );
      if (!persistedAdmin) throw new Error('C1 administrator missing after confirmation');
      expect(persistedAdmin.role).toBe('admin');
      const fateClient = createFateClient({
        url: `${browserControlOrigin}/admin/fate`,
        headers: {
          Cookie: `admin_token=${administratorCookie.value}`,
          Origin: browserControlOrigin,
        },
      });
      await expect(fateClient.request(projectsPageRequest('/admin/users'))).rejects.toMatchObject({
        status: 400,
      });
      const protectedProbe = await page.evaluate(async () => {
        const response = await fetch('/admin/__management_auth_probe__', { redirect: 'manual' });
        return { status: response.status, location: response.headers.get('Location') };
      });
      expect(protectedProbe).toEqual({ status: 404, location: null });
      const cliRequest = await page.evaluate(async () => {
        const response = await fetch('/projects');
        return { status: response.status, body: await response.json() };
      });
      expect(cliRequest).toEqual({ status: 401, body: { error: 'unauthorized' } });

      if (authDenialsOnly) {
        const authDenialCases: Array<Record<string, unknown>> = [];
        const csrfCases: Array<Record<string, unknown>> = [];
        const evidence: Record<string, unknown> = {
          profile: 'auth-denials-only',
          setup: {},
          protectedHtml: null,
          callbackPrivacyHeaders: null,
          baseline: null,
          denials: authDenialCases,
          csrf: csrfCases,
          csrfStateUnchanged: false,
          finalStateRestored: false,
        };
        authDenialEvidence = evidence;
        const providerCountsAtEntry = {
          discoveryRequests,
          authorizationRequests,
          tokenRequests,
          keyRequests,
        };
        expect(providerCountsAtEntry.discoveryRequests).toBe(1);
        expect(providerCountsAtEntry.authorizationRequests).toBe(1);
        expect(providerCountsAtEntry.tokenRequests).toBe(1);
        expect(providerCountsAtEntry.keyRequests).toBeGreaterThanOrEqual(1);

        const persistentStateFingerprint = async (): Promise<string> => {
          const [userState, identityState, sessionState, connectionState, settingState, bootstrapState, projectState] =
            await Promise.all([
              env.db
                .select({
                  id: users.id,
                  provider: users.provider,
                  provider_id: users.provider_id,
                  role: users.role,
                  suspended_reason: users.suspended_reason,
                })
                .from(users)
                .orderBy(users.id),
              env.db.select().from(platformLoginIdentities).orderBy(platformLoginIdentities.id),
              env.db.select().from(platformHumanSessions).orderBy(platformHumanSessions.id),
              env.db.select().from(platformLoginConnections).orderBy(platformLoginConnections.id),
              env.db.select().from(platformAuthSettings).orderBy(platformAuthSettings.singleton),
              env.db.select().from(platformAuthBootstrap).orderBy(platformAuthBootstrap.singleton),
              env.db
                .select({ id: projects.id, user_id: projects.user_id, slug: projects.slug })
                .from(projects)
                .orderBy(projects.id),
            ]);
          const ownerState = await env.db.execute(sql`
            SELECT installation_id, ownership_nonce, lifecycle_manifest
            FROM public.__void_platform_installation
            ORDER BY singleton
          `);
          return createHash('sha256')
            .update(
              JSON.stringify({
                userState,
                identityState,
                sessionState,
                connectionState,
                settingState,
                bootstrapState,
                projectState,
                ownerState: ownerState.rows,
              }),
            )
            .digest('hex');
        };

        type ManagementRequestOptions = {
          cookie?: string | null;
          method?: 'GET' | 'POST';
          origin?: string;
          body?: string;
          accept?: string;
        };
        const managementRequest = (path: string, options: ManagementRequestOptions = {}) => {
          const headers = new Headers();
          if (options.cookie) headers.set('Cookie', `admin_token=${options.cookie}`);
          if (options.origin) headers.set('Origin', options.origin);
          if (options.body !== undefined) headers.set('Content-Type', 'application/json');
          if (options.accept) headers.set('Accept', options.accept);
          return fetch(new URL(path, browserControlOrigin), {
            method: options.method ?? 'GET',
            headers,
            ...(options.body !== undefined ? { body: options.body } : {}),
            redirect: 'manual',
          });
        };
        const getProtectedStatus = async (cookie: string | null): Promise<number> => {
          const response = await managementRequest('/admin/projects', { cookie, accept: 'text/html' });
          const status = response.status;
          await response.arrayBuffer();
          return status;
        };
        const observeLoginRedirect = async (
          name: string,
          cookie: string | null,
        ): Promise<Record<string, unknown> & { status: number; redirectsToLogin: boolean }> => {
          const response = await managementRequest('/admin/projects', { cookie, accept: 'text/html' });
          const observed = {
            case: name,
            status: response.status,
            redirectsToLogin: response.headers.get('location') === '/admin/login',
          };
          await response.arrayBuffer();
          authDenialCases.push(observed);
          return observed;
        };
        const expectLoginRedirect = async (name: string, cookie: string | null) => {
          const observed = await observeLoginRedirect(name, cookie);
          expect(observed.status).toBe(302);
          expect(observed.redirectsToLogin).toBe(true);
          return observed;
        };

        const initialStateFingerprint = await persistentStateFingerprint();
        const protectedHtml = await managementRequest('/admin/projects', {
          cookie: administratorCookie.value,
          accept: 'text/html',
        });
        const protectedHtmlHeaders = {
          status: protectedHtml.status,
          xFrameOptions: protectedHtml.headers.get('x-frame-options'),
          contentSecurityPolicy: protectedHtml.headers.get('content-security-policy'),
          cacheControl: protectedHtml.headers.get('cache-control'),
          referrerPolicy: protectedHtml.headers.get('referrer-policy'),
        };
        await protectedHtml.arrayBuffer();
        evidence.protectedHtml = protectedHtmlHeaders;
        expect(protectedHtmlHeaders.status).toBe(200);
        expect(protectedHtmlHeaders.xFrameOptions).toBe('DENY');
        expect(protectedHtmlHeaders.contentSecurityPolicy).toBe("frame-ancestors 'none'");
        expect(protectedHtmlHeaders.cacheControl).toBe('private, no-store');
        // This route has no Referrer-Policy middleware in the source; auth-config/callback routes set theirs explicitly.
        expect(protectedHtmlHeaders.referrerPolicy).toBeNull();

        const callbackPrivacy = await managementRequest('/auth/callback?state=unmanaged', {
          accept: 'application/json',
        });
        const callbackPrivacyHeaders = {
          status: callbackPrivacy.status,
          cacheControl: callbackPrivacy.headers.get('cache-control'),
          referrerPolicy: callbackPrivacy.headers.get('referrer-policy'),
        };
        await callbackPrivacy.arrayBuffer();
        evidence.callbackPrivacyHeaders = callbackPrivacyHeaders;
        expect(callbackPrivacyHeaders).toEqual({
          status: 400,
          cacheControl: 'no-store',
          referrerPolicy: 'no-referrer',
        });

        const protectedStatus = await getProtectedStatus(administratorCookie.value);
        expect(protectedStatus).toBe(200);
        const actualFateBody = fateRequestBodies.find((body) => body.trim().length > 0);
        expect(actualFateBody).toBeTruthy();
        if (!actualFateBody) throw new Error('genuine_fate_request_body_missing');
        const validFateResponse = await managementRequest('/admin/fate', {
          cookie: administratorCookie.value,
          method: 'POST',
          origin: browserControlOrigin,
          body: actualFateBody,
        });
        const validFateStatus = validFateResponse.status;
        await validFateResponse.arrayBuffer();
        expect(validFateStatus).toBe(200);

        const cliPositive = await fetch(`http://127.0.0.1:${backendPort}/projects/${seed.projectId}`, {
          headers: { Authorization: `Bearer ${identity.token}` },
          redirect: 'manual',
        });
        const cliBearerStatus = cliPositive.status;
        await cliPositive.arrayBuffer();
        expect(cliBearerStatus).toBe(200);
        evidence.baseline = {
          protectedGetStatus: protectedStatus,
          sameOriginFatePostStatus: validFateStatus,
          cliCookieOnlyStatus: cliRequest.status,
          cliBearerProjectStatus: cliBearerStatus,
          genuineFateBodyUsed: true,
        };

        const runtimeManagementConfig = await enrollment.readCasimirManagementConfig(
          join(state, 'management.json'),
        );
        expect(runtimeManagementConfig.operatorId).toBe(config.operatorId);
        expect(runtimeManagementConfig.installationId).toBe(config.installationId);
        const issuedClaims = await verifyJwt(
          administratorCookie.value,
          runtimeManagementConfig.jwtSecret,
          'admin',
        );
        expect(issuedClaims).toMatchObject({
          sub: seed.operatorId,
          aud: 'admin',
        });
        expect(issuedClaims?.sid).toBeTruthy();
        if (!issuedClaims?.sid) throw new Error('issued_admin_cookie_failed_local_verification');
        const tokenParts = administratorCookie.value.split('.');
        if (tokenParts.length !== 3) throw new Error('issued_admin_token_invalid_shape');
        const tokenClaims = issuedClaims;
        const signature = tokenParts[2]!;
        const invalidSignatureToken = `${tokenParts[0]}.${tokenParts[1]}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const wrongAudienceToken = await new SignJWT({
          sub: tokenClaims.sub,
          login: tokenClaims.login,
          aud: 'api',
          sid: tokenClaims.sid,
        })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setIssuedAt()
          .setExpirationTime(nowSeconds + 300)
          .sign(new TextEncoder().encode(runtimeManagementConfig.jwtSecret));
        const expiredAdminToken = await new SignJWT({
          sub: tokenClaims.sub,
          login: tokenClaims.login,
          aud: 'admin',
          sid: tokenClaims.sid,
        })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setIssuedAt(nowSeconds - 120)
          .setExpirationTime(nowSeconds - 60)
          .sign(new TextEncoder().encode(runtimeManagementConfig.jwtSecret));

        const wrongAudienceClaims = await verifyJwt(
          wrongAudienceToken,
          runtimeManagementConfig.jwtSecret,
          'api',
        );
        expect(wrongAudienceClaims).toMatchObject({ aud: 'api', sub: tokenClaims.sub, sid: tokenClaims.sid });
        expect(
          await verifyJwt(wrongAudienceToken, runtimeManagementConfig.jwtSecret, 'admin'),
        ).toBeNull();
        expect(
          await verifyJwt(invalidSignatureToken, runtimeManagementConfig.jwtSecret, 'admin'),
        ).toBeNull();
        const expiredTokenParts = expiredAdminToken.split('.');
        expect(expiredTokenParts).toHaveLength(3);
        expect(
          await hmacVerifyState(
            `${expiredTokenParts[0]}.${expiredTokenParts[1]}`,
            expiredTokenParts[2]!,
            runtimeManagementConfig.jwtSecret,
          ),
        ).toBe(true);
        expect(
          await verifyJwt(expiredAdminToken, runtimeManagementConfig.jwtSecret, 'admin'),
        ).toBeNull();

        await expectLoginRedirect('missing-cookie', null);
        await expectLoginRedirect('invalid-signature', invalidSignatureToken);
        await expectLoginRedirect('valid-signature-wrong-audience', wrongAudienceToken);
        await expectLoginRedirect('valid-signature-expired', expiredAdminToken);

        const currentSession = (await env.db.select().from(platformHumanSessions)).find(
          (session) => session.id === tokenClaims.sid,
        );
        if (!currentSession) throw new Error('issued_admin_session_missing');
        const currentConnection = (await env.db.select().from(platformLoginConnections)).find(
          (connection) => connection.id === currentSession.connection_id,
        );
        if (!currentConnection) throw new Error('issued_admin_connection_missing');
        const originalUser = (await env.db.select().from(users)).find((user) => user.id === tokenClaims.sub);
        if (!originalUser) throw new Error('issued_admin_user_missing');

        const runDurableDenial = async (
          name: string,
          mutate: () => Promise<unknown>,
          restore: () => Promise<unknown>,
        ) => {
          let observed: Awaited<ReturnType<typeof observeLoginRedirect>> | undefined;
          try {
            await mutate();
            observed = await observeLoginRedirect(name, administratorCookie.value);
          } finally {
            await restore();
          }
          if (!observed) throw new Error(`auth_denial_observation_missing:${name}`);
          const restoredBaselineStatus = await getProtectedStatus(administratorCookie.value);
          observed.restored = true;
          observed.restoredBaselineStatus = restoredBaselineStatus;
          expect(observed.status).toBe(302);
          expect(observed.redirectsToLogin).toBe(true);
          expect(restoredBaselineStatus).toBe(200);
        };

        await runDurableDenial(
          'durable-session-revoked',
          () =>
            env.db
              .update(platformHumanSessions)
              .set({ revoked_at: new Date().toISOString() })
              .where(eq(platformHumanSessions.id, currentSession.id)),
          () =>
            env.db
              .update(platformHumanSessions)
              .set({ revoked_at: currentSession.revoked_at })
              .where(eq(platformHumanSessions.id, currentSession.id)),
        );
        await runDurableDenial(
          'durable-session-expired',
          () =>
            env.db
              .update(platformHumanSessions)
              .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
              .where(eq(platformHumanSessions.id, currentSession.id)),
          () =>
            env.db
              .update(platformHumanSessions)
              .set({ expires_at: currentSession.expires_at })
              .where(eq(platformHumanSessions.id, currentSession.id)),
        );
        await runDurableDenial(
          'current-role-demoted',
          () => env.db.update(users).set({ role: 'user' }).where(eq(users.id, originalUser.id)),
          () => env.db.update(users).set({ role: originalUser.role }).where(eq(users.id, originalUser.id)),
        );
        await runDurableDenial(
          'current-admin-suspended',
          () =>
            env.db
              .update(users)
              .set({ suspended_reason: 'management-denial-test' })
              .where(eq(users.id, originalUser.id)),
          () =>
            env.db
              .update(users)
              .set({ suspended_reason: originalUser.suspended_reason })
              .where(eq(users.id, originalUser.id)),
        );
        await runDurableDenial(
          'login-connection-disabled',
          () =>
            env.db
              .update(platformLoginConnections)
              .set({ enabled: false })
              .where(eq(platformLoginConnections.id, currentConnection.id)),
          () =>
            env.db
              .update(platformLoginConnections)
              .set({ enabled: currentConnection.enabled })
              .where(eq(platformLoginConnections.id, currentConnection.id)),
        );
        await runDurableDenial(
          'login-connection-generation-changed',
          () =>
            env.db
              .update(platformLoginConnections)
              .set({ generation: currentConnection.generation + 1 })
              .where(eq(platformLoginConnections.id, currentConnection.id)),
          () =>
            env.db
              .update(platformLoginConnections)
              .set({ generation: currentConnection.generation })
              .where(eq(platformLoginConnections.id, currentConnection.id)),
        );

        const beforeCsrfFingerprint = await persistentStateFingerprint();
        const sendCsrfProbe = async (name: string, origin: string | null) => {
          const headers = new Headers({
            Cookie: `admin_token=${administratorCookie.value}`,
            'Content-Type': 'application/json',
          });
          if (origin !== null) headers.set('Origin', origin);
          const response = await fetch(new URL('/admin/fate', browserControlOrigin), {
            method: 'POST',
            headers,
            body: actualFateBody,
            redirect: 'manual',
          });
          const observed = { case: name, status: response.status, denied: response.status === 403 };
          await response.arrayBuffer();
          csrfCases.push(observed);
          expect(observed.status).toBe(403);
        };
        await sendCsrfProbe('cross-origin', 'https://attacker.example.net');
        await sendCsrfProbe('missing-origin-and-referer', null);
        await sendCsrfProbe('same-host-wrong-scheme', 'http://control.example.com:8443');
        const afterCsrfFingerprint = await persistentStateFingerprint();
        evidence.csrfStateUnchanged = afterCsrfFingerprint === beforeCsrfFingerprint;
        expect(evidence.csrfStateUnchanged).toBe(true);

        const finalFingerprint = await persistentStateFingerprint();
        evidence.finalStateRestored = finalFingerprint === initialStateFingerprint;
        expect(evidence.finalStateRestored).toBe(true);
        const confirmedBootstrap = await env.db.select().from(platformAuthBootstrap);
        const confirmedSettings = await env.db.select().from(platformAuthSettings);
        const confirmedSessions = await env.db.select().from(platformHumanSessions);
        const confirmedIdentities = await env.db.select().from(platformLoginIdentities);
        const confirmedUsers = await env.db.select().from(users);
        expect(confirmedBootstrap).toEqual(bootstrapStateAfterConfirmation);
        expect(confirmedSettings).toEqual(authSettingsAfterConfirmation);
        expect(confirmedBootstrap[0]?.consumed_at).toBeTruthy();
        expect(confirmedSessions).toHaveLength(1);
        expect(confirmedIdentities).toHaveLength(1);
        expect(confirmedUsers).toHaveLength(1);
        expect(confirmedUsers[0]?.role).toBe('admin');
        expect(discoveryRequests).toBe(providerCountsAtEntry.discoveryRequests);
        expect(authorizationRequests).toBe(providerCountsAtEntry.authorizationRequests);
        expect(tokenRequests).toBe(providerCountsAtEntry.tokenRequests);
        expect(keyRequests).toBe(providerCountsAtEntry.keyRequests);
        expect(providerFailure).toBeUndefined();
        evidence.setup = {
          ...providerCountsAtEntry,
          consumedBootstrap: Boolean(confirmedBootstrap[0]?.consumed_at),
          administratorCount: confirmedUsers.length,
          identityCount: confirmedIdentities.length,
          humanSessionCount: confirmedSessions.length,
          cliCookieOnlyDenied: cliRequest.status === 401,
        };
        browserEvidenceStatus = 'passed';
        return;
      }

      const seededProject = (await env.db.select().from(projects)).find(
        (project) => project.id === seed.projectId,
      );
      if (!seededProject) throw new Error('C1 seed project missing after bootstrap');
      if (!fateLifecycleOnly) {
        browserPhase = 'projects-initial-entry';
        const projectsPage = await page.goto(`${browserControlOrigin}/admin/projects`);
        expect(projectsPage?.status()).toBe(200);
        expect(await page.getByRole('heading', { name: 'Projects' }).count()).toBe(1);
        await page.waitForLoadState('networkidle');
        expect(assetResponses.get('/admin/client.js')).toBe(200);
        expect(assetResponses.get('/admin/style.css')).toBe(200);
        browserPhase = 'projects-search';
        await page.getByPlaceholder('Search projects').fill('casimir-secondary');
        const secondarySuggestion = page
          .locator('.void-admin-search')
          .getByText('casimir-secondary', { exact: true });
        await secondarySuggestion.waitFor({ state: 'visible' });
        expect(fateRequestBodies.some((body) => body.includes('/admin/projects?search=casimir-secondary'))).toBe(true);
        const pagesNavigation = await page.evaluate(async () => {
          const response = await fetch('/admin/projects', { headers: { 'X-VoidPages': 'true' } });
          return {
            status: response.status,
            cacheControl: response.headers.get('cache-control'),
            vary: response.headers.get('vary'),
            page: await response.json(),
          };
        });
        expect(pagesNavigation).toMatchObject({
          status: 200,
          cacheControl: 'private, no-store',
          vary: 'X-VoidPages',
          page: { component: 'projects', shared: { adminPageUrl: '/admin/projects' } },
        });
        const seededProjectRow = page
          .locator('.void-admin-projects-table tr')
          .filter({ hasText: seededProject.slug });
        expect(await seededProjectRow.getByRole('link', { name: seededProject.slug, exact: true }).count()).toBe(1);
        expect(await seededProjectRow.locator('.void-admin-url').getAttribute('href')).toBe(
          'https://app.example.com:8444',
        );
        const secondaryProjectRow = page
          .locator('.void-admin-projects-table tr')
          .filter({ hasText: secondaryProject.slug });
        expect(await secondaryProjectRow.locator('.void-admin-url').count()).toBe(0);
        expect(await secondaryProjectRow.locator('td').nth(1).textContent()).toContain('Unavailable');
        browserPhase = 'project-detail';
        const projectDetail = await page.evaluate(async (path) => {
          const response = await fetch(path, {
            headers: { 'X-VoidPages': 'true' },
            signal: AbortSignal.timeout(5_000),
          });
          return { status: response.status, page: await response.json().catch(() => null) };
        }, `/admin/projects/${seededProject.id}`);
        expect(projectDetail).toMatchObject({
          status: 200,
          page: {
            component: 'projectDetail',
            shared: { adminPageUrl: `/admin/projects/${seededProject.id}` },
          },
        });
        await Promise.all([
          page.waitForURL(`${browserControlOrigin}/admin/projects/${seededProject.id}`, {
            timeout: 10_000,
          }),
          seededProjectRow.getByRole('link', { name: seededProject.slug, exact: true }).click(),
        ]);
        await page.getByRole('heading', { name: seededProject.slug }).waitFor({ timeout: 5_000 });
        await page.getByRole('heading', { name: 'Recent Deployments (0)' }).waitFor();
        expect(await page.getByRole('heading', { name: 'Resources (0)' }).count()).toBe(1);
        expect(await page.getByRole('heading', { name: 'Builds (0)' }).count()).toBe(1);
        expect(await page.getByRole('link', { name: 'https://app.example.com:8444' }).count()).toBe(1);
        expect(fateRequestBodies.some((body) => body.includes(`/admin/projects/${seededProject.id}`))).toBe(true);
        await page.reload();
        await page.getByRole('heading', { name: seededProject.slug }).waitFor();
        browserPhase = 'projects-back';
        await page.goBack();
        await page.getByRole('heading', { name: 'Projects' }).waitFor();
        expect(page.url()).toBe(`${browserControlOrigin}/admin/projects`);
      }
      expect(await env.db.select().from(deploymentRows)).toHaveLength(0);
      let deploymentId: string;
      let deploymentSource: 'casimir-artifact' | 'casimir-record';
      let expectedNativeManifest: string | undefined;
      if (artifactAdmissionEnabled) {
        const artifactProjectRoot = join(state, 'native-artifact-project');
        await mkdir(join(artifactProjectRoot, 'dist/ssr'), { recursive: true });
        await mkdir(join(artifactProjectRoot, 'dist/client'), { recursive: true });
        await mkdir(join(artifactProjectRoot, 'db/migrations'), { recursive: true });
        await writeFile(
          join(artifactProjectRoot, 'dist/ssr/app.js'),
          'export default { fetch: () => new Response("Casimir artifact fixture") };',
        );
        await writeFile(
          join(artifactProjectRoot, 'dist/client/index.html'),
          '<!doctype html><title>Casimir artifact fixture</title>',
        );
        await writeFile(
          join(artifactProjectRoot, 'db/migrations/0001_fixture.sql'),
          'CREATE TABLE casimir_fixture (id integer PRIMARY KEY);',
        );
        const artifact = await buildCasimirArtifact(artifactProjectRoot, profile.runtime);
        expectedNativeManifest = JSON.stringify(artifact.manifest, null, 2);
        const artifactBytes = await readFile(artifact.path);
        const uploadResponse = await fetch(
          `http://127.0.0.1:${backendPort}/casimir/v1/projects/${seededProject.id}/uploads`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${identity.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ bytes: artifactBytes.byteLength, sha256: artifact.sha256 }),
          },
        );
        expect(uploadResponse.status, await uploadResponse.clone().text()).toBe(201);
        const { uploadId } = (await uploadResponse.json()) as { uploadId: string };
        const contentResponse = await fetch(
          `http://127.0.0.1:${backendPort}/casimir/v1/projects/${seededProject.id}/uploads/${uploadId}/content`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${identity.token}` },
            body: artifactBytes,
          },
        );
        expect(contentResponse.status, await contentResponse.clone().text()).toBe(200);
        const finalizeResponse = await fetch(
          `http://127.0.0.1:${backendPort}/casimir/v1/projects/${seededProject.id}/uploads/${uploadId}/finalize`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${identity.token}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          },
        );
        expect(finalizeResponse.status, await finalizeResponse.clone().text()).toBe(200);
        const { artifactId } = (await finalizeResponse.json()) as { artifactId: string };
        expect(artifactId).toMatch(/^car_[a-z0-9]{12}$/);
        const admissionResponse = await fetch(
          `http://127.0.0.1:${backendPort}/casimir/v1/projects/${seededProject.id}/deployments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${identity.token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `management-manifest-${artifact.sha256.slice(0, 40)}`,
            },
            body: JSON.stringify({ artifactId }),
          },
        );
        expect(admissionResponse.status, await admissionResponse.clone().text()).toBe(202);
        const admission = (await admissionResponse.json()) as {
          operationId: string;
          deploymentId: string;
        };
        deploymentId = admission.deploymentId;
        deploymentSource = 'casimir-artifact';
        const [admittedDeployment] = await env.db
          .select()
          .from(deploymentRows)
          .where(eq(deploymentRows.id, deploymentId));
        expect(admittedDeployment).toMatchObject({
          id: deploymentId,
          project_id: seededProject.id,
          status: 'pending',
          source: 'casimir-artifact',
          deployed_at: null,
        });
        expect(JSON.parse(admittedDeployment?.manifest ?? 'null')).toEqual(artifact.manifest);
        const operation = await env.db.execute<{
          phase: string;
          image_id: string | null;
          observation: unknown;
        }>(sql`
          SELECT phase, image_id, observation
          FROM casimir_mvp_a.operations
          WHERE id=${admission.operationId}
        `);
        expect(operation.rows).toEqual([{ phase: 'queued', image_id: null, observation: null }]);
      } else {
        const deploymentIntentResponse = await fetch(
          `http://127.0.0.1:${backendPort}/projects/${seededProject.id}/deployments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${identity.token}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          },
        );
        expect(deploymentIntentResponse.status).toBe(201);
        const deploymentIntent = (await deploymentIntentResponse.json()) as { id: string };
        deploymentId = deploymentIntent.id;
        deploymentSource = 'casimir-record';
        expect(await env.db.select().from(deploymentRows)).toMatchObject([
          expect.objectContaining({
            id: deploymentId,
            project_id: seededProject.id,
            status: 'pending',
            source: 'casimir-record',
            manifest: null,
            deployed_at: null,
          }),
        ]);
      }
      if (fateLifecycleOnly) {
        const lifecycleBuild = await buildFateLifecycleClient(state);
        lifecycleBuildManifest = lifecycleBuild.manifest;
        lifecycleGate = createLifecycleResponseGate('initial-suspense', 2);
        browserPhase = 'fate-lifecycle-initial-suspense';
        await page.route('**/__test/fate-lifecycle', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: { 'Cache-Control': 'no-store' },
            body: '<!doctype html><html><head><meta charset="utf-8"><title>Fate lifecycle fixture</title></head><body><div id="app"></div><script src="/__test/fate-lifecycle-client.js" defer></script></body></html>',
          });
        });
        await page.route('**/__test/fate-lifecycle-client.js', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            headers: { 'Cache-Control': 'no-store' },
            body: lifecycleBuild.client,
          });
        });
        await page.goto(`${browserControlOrigin}/__test/fate-lifecycle`, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('lifecycle-controls').waitFor({ timeout: 5_000 });
        const initialGate = lifecycleGate;
        if (!initialGate) throw new Error('lifecycle_response_gate_missing');
        const firstResponse = await initialGate.waitForRequest(1, 8_000);
        expect(firstResponse).not.toBeNull();
        if (!firstResponse) throw new Error('lifecycle_first_fate_response_timeout');
        expect(firstResponse.status).toBe(200);
        expect(firstResponse.contentType).toContain('application/json');
        await page.getByTestId('suspense-fallback').waitFor({ state: 'visible', timeout: 5_000 });
        const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
        await page.evaluate(() => {
          const trace = Reflect.get(window, '__CASIMIR_FATE_LIFECYCLE_TRACE__');
          if (!trace || typeof Reflect.get(trace, 'setPhase') !== 'function') {
            throw new Error('lifecycle_trace_api_unavailable');
          }
          Reflect.apply(Reflect.get(trace, 'setPhase') as (...args: unknown[]) => unknown, trace, [
            'pending-parent-rerender',
          ]);
        });
        browserPhase = 'fate-lifecycle-pending-parent-rerender';
        await page.getByTestId('force-rerender').click();
        await page.getByTestId('lifecycle-revision').getByText('1').waitFor({ timeout: 5_000 });
        await page.waitForFunction(
          () => {
            const trace = Reflect.get(window, '__CASIMIR_FATE_LIFECYCLE_TRACE__');
            const snapshot = Reflect.apply(Reflect.get(trace, 'snapshot') as (...args: never[]) => unknown, trace, []) as {
              events?: Array<Record<string, unknown>>;
            };
            return snapshot.events?.some(
              (event) => event.phase === 'pending-parent-rerender' && event.kind === 'prepareRequestForRender',
            ) === true;
          },
          undefined,
          { timeout: 3_000 },
        );
        const duplicateBeforeRelease = await initialGate.waitForRequest(2, 500);
        const pendingSnapshot = await page.evaluate(() => {
          const trace = Reflect.get(window, '__CASIMIR_FATE_LIFECYCLE_TRACE__');
          return Reflect.apply(Reflect.get(trace, 'snapshot') as (...args: never[]) => unknown, trace, []) as Record<string, unknown>;
        });
        const pendingEvents = Array.isArray(pendingSnapshot.events)
          ? pendingSnapshot.events as Array<Record<string, unknown>>
          : [];
        const pendingPrepareEvents = pendingEvents.filter(
          (event) => event.phase === 'pending-parent-rerender' && event.kind === 'prepareRequestForRender',
        );
        const normalizedRequestEvents = pendingEvents.filter(
          (event) => event.kind === 'requestWithDescriptor' && event.descriptorStage === 'normalized',
        );
        const normalizedDescriptorKeyIds = new Set(
          normalizedRequestEvents.map((event) => event.descriptorKeyId).filter((id): id is string => typeof id === 'string'),
        );
        const rawDescriptorKeyIds = [...new Set(
          pendingPrepareEvents.map((event) => event.descriptorKeyId).filter((id): id is string => typeof id === 'string'),
        )];
        lifecycleEvidence = {
          scope: 'initial Suspense boundary above SharedContext/AdminProviders; no page-navigation or auth-portability claim',
          documentTimeOrigin,
          fallbackVisibleWhileResponseHeld: true,
          gate: {
            phase: initialGate.phase,
            maxHeldRequests: initialGate.maxRequests,
            requests: initialGate.requests.map((request) => ({
              index: request.index,
              signature: request.signature,
              status: request.status,
              contentType: request.contentType,
              error: request.error,
            })),
            abortedAtCap: initialGate.aborted,
          },
          pendingParentRerender: {
            revision: 1,
            prepareEvents: pendingPrepareEvents.length,
            rawDescriptorKeyIds,
            normalizedDescriptorKeyIds: [...normalizedDescriptorKeyIds],
            descriptorRequests: normalizedRequestEvents.map((event) => ({
              clientId: event.clientId,
              descriptorStage: event.descriptorStage,
              descriptorKeyId: event.descriptorKeyId,
              handleId: event.handleId,
              handleAction: event.handleAction,
              status: event.status,
            })),
            clients: pendingSnapshot.clients,
            snapshot: pendingSnapshot,
          },
          secondTransportObservedBeforeRelease: duplicateBeforeRelease !== null,
          postRelease: null,
        };
        console.error(`[management fate lifecycle initial-suspense] ${JSON.stringify(lifecycleEvidence)}`);
        expect(pendingSnapshot.clients).toBeDefined();
        expect((pendingSnapshot.clients as Array<{ unavailableMethods?: string[] }>).every(
          (client) => (client.unavailableMethods ?? []).length === 0,
        )).toBe(true);
        expect(pendingPrepareEvents.length).toBeGreaterThanOrEqual(1);
        expect(normalizedRequestEvents.length).toBeGreaterThanOrEqual(1);
        expect(normalizedDescriptorKeyIds.size).toBe(1);
        expect(duplicateBeforeRelease).toBeNull();
        expect(initialGate.requests).toHaveLength(1);
        const initialClientIds = new Set(normalizedRequestEvents.map((event) => event.clientId));
        const initialHandleIds = new Set(normalizedRequestEvents.map((event) => event.handleId));
        expect(initialClientIds.size).toBe(1);
        expect(initialHandleIds.size).toBe(1);
        expect([...initialHandleIds].every((id) => typeof id === 'string')).toBe(true);

        firstResponse.release();
        await firstResponse.delivered;
        const afterRelease = await Promise.all([
          page.getByRole('heading', { name: 'Deployments', exact: true })
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => 'committed' as const)
            .catch(() => 'not-committed' as const),
          initialGate.waitForRequest(2, 5_000).then((request) => request ? 'second-transport' as const : 'no-second-transport' as const),
        ]);
        await page.waitForLoadState('networkidle', { timeout: 5_000 });
        await Promise.allSettled(fateResponseTasks);
        const finalSnapshot = await page.evaluate(() => {
          const trace = Reflect.get(window, '__CASIMIR_FATE_LIFECYCLE_TRACE__');
          return Reflect.apply(Reflect.get(trace, 'snapshot') as (...args: never[]) => unknown, trace, []) as Record<string, unknown>;
        });
        lifecycleEvidence = {
          ...(lifecycleEvidence ?? {}),
          postRelease: {
            pageResult: afterRelease[0],
            transportResult: afterRelease[1],
            gate: {
              requests: initialGate.requests.map((request) => ({
                index: request.index,
                signature: request.signature,
                status: request.status,
                contentType: request.contentType,
                error: request.error,
              })),
              abortedAtCap: initialGate.aborted,
            },
            clients: finalSnapshot.clients,
            snapshot: finalSnapshot,
          },
        };
        console.error(`[management fate lifecycle initial-suspense final] ${JSON.stringify(lifecycleEvidence)}`);
        expect(afterRelease[0]).toBe('committed');
        expect(afterRelease[1]).toBe('no-second-transport');
        expect(initialGate.requests).toHaveLength(1);
        expect((finalSnapshot.clients as Array<unknown> | undefined)?.length).toBe(1);
        expect(fateRequestCap).toBeNull();
        expect(browserErrors).toEqual([]);
        expect((await page.context().cookies(browserControlOrigin)).some((cookie) => cookie.name === 'admin_token')).toBe(true);
        expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
        expect(await env.db.select().from(platformAuthBootstrap)).toEqual(bootstrapStateAfterConfirmation);
        expect(await env.db.select().from(platformAuthSettings)).toEqual(authSettingsAfterConfirmation);
        const lifecycleUsers = await env.db.select().from(users);
        expect(lifecycleUsers).toHaveLength(1);
        expect(lifecycleUsers).toMatchObject([
          expect.objectContaining({ id: seed.operatorId, role: 'admin', provider: 'casimir-local' }),
        ]);
        const lifecycleIdentities = await env.db.select().from(platformLoginIdentities);
        expect(lifecycleIdentities).toHaveLength(1);
        expect(lifecycleIdentities).toMatchObject([
          expect.objectContaining({
            user_id: seed.operatorId,
            issuer: browserIssuer,
            subject: 'casimir-owner-subject',
          }),
        ]);
        expect(await env.db.select().from(projects)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: seed.projectId, user_id: seed.operatorId }),
            expect.objectContaining({ id: secondaryProject.id, user_id: seed.operatorId }),
          ]),
        );
        const [lifecycleDeployment] = await env.db
          .select()
          .from(deploymentRows)
          .where(eq(deploymentRows.id, deploymentId));
        expect(lifecycleDeployment).toMatchObject({
          id: deploymentId,
          project_id: seededProject.id,
          status: 'pending',
          source: deploymentSource,
          deployed_at: null,
        });
        lifecycleGate = null;
        browserEvidenceStatus = 'passed';
        return;
      }
      try {
        browserPhase = 'deployments-navigation';
        await Promise.all([
          page.waitForURL(`${browserControlOrigin}/admin/deployments`, { timeout: 10_000, waitUntil: 'commit' }),
          page.getByRole('link', { name: 'Deployments', exact: true }).click(),
        ]);
        browserPhase = 'deployments-loaded';
      } catch (error) {
        await Promise.allSettled(fateResponseTasks);
        if (fateRequestCap) {
          printDiagnostics('management fate request cap');
          throw new Error(`fixture_fate_request_cap:${JSON.stringify(fateRequestCap)}`, { cause: error });
        }
        const navigationSnapshot = await page.evaluate(() => {
          const isVisible = (element: Element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          return {
            path: location.pathname,
            viewport: { width: innerWidth, height: innerHeight },
            clientWidth: document.documentElement.clientWidth,
            links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
              .map((link) => ({
                path: new URL(link.href).pathname,
                text: link.innerText.trim(),
                visible: isVisible(link),
              }))
              .filter((link) => link.path.startsWith('/admin/')),
            menuButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
              .map((button) => ({ text: button.innerText.trim(), expanded: button.getAttribute('aria-expanded') })),
          };
        });
        console.error(`[management deployments navigation] ${JSON.stringify({ navigationSnapshot, fateDiagnostics: diagnostics() })}`);
        fateDiagnosticsPrinted = true;
        throw error;
      }
      await page.getByRole('heading', { name: 'Deployments' }).waitFor({ timeout: 5_000 });
      await page.waitForLoadState('networkidle', { timeout: 5_000 });
      await Promise.all(fateResponseTasks);
      const deploymentsPageGroup = [...fateGroups.values()].find(
        (group) =>
          group.phase === 'deployments-navigation' &&
          group.requestSummary.some((operation) => operation.name === 'deploymentsPage'),
      );
      const deploymentResponseShape = deploymentsPageGroup?.responses[0]?.bodyShape as
        | { fields?: Array<string>; timezoneTypes?: Record<string, number> }
        | undefined;
      const deploymentSelection = deploymentsPageGroup?.requestSummary.find(
        (operation) => operation.name === 'deploymentsPage',
      )?.selectedFields as Array<string> | undefined;
      const availableDeploymentFields = new Set(deploymentResponseShape?.fields ?? []);
      const presentDeploymentFields = (deploymentSelection ?? []).filter((field) =>
        availableDeploymentFields.has(`results.data.${field}`),
      );
      const missingDeploymentFields = (deploymentSelection ?? []).filter(
        (field) => !availableDeploymentFields.has(`results.data.${field}`),
      );
      const deploymentSignature = deploymentsPageGroup?.signature;
      const requestsBeforeSteadyWindow = deploymentSignature
        ? fateSignatureCounts.get(deploymentSignature) ?? 0
        : 0;
      const steadyStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await settleFateResponses();
      const requestsAfterSteadyWindow = deploymentSignature
        ? fateSignatureCounts.get(deploymentSignature) ?? 0
        : 0;
      const steadyElapsedMs = Date.now() - steadyStartedAt;
      deploymentSteadyObservation = {
        durationMs: 2_000,
        elapsedMs: steadyElapsedMs,
        requestCountBefore: requestsBeforeSteadyWindow,
        requestCountAfter: requestsAfterSteadyWindow,
        additionalIdenticalRequests: requestsAfterSteadyWindow - requestsBeforeSteadyWindow,
        signature: deploymentSignature ?? null,
        totalFateRequestsAfter: fateRequestTotal,
        capReached: fateRequestCap !== null,
      };
      deploymentCompleteness = {
        phase: 'deployments-navigation',
        querySignature: deploymentSignature ?? null,
        selectedFields: deploymentSelection ?? [],
        responseFields: deploymentResponseShape?.fields ?? [],
        presentFields: presentDeploymentFields,
        missingFields: missingDeploymentFields,
        timezoneTypes: deploymentResponseShape?.timezoneTypes ?? {},
        requestCount: deploymentsPageGroup?.requests ?? 0,
        abortedCount: deploymentsPageGroup?.aborted ?? 0,
        responseStatuses: deploymentsPageGroup?.responses.map((response) => response.status) ?? [],
        responseMetadata: deploymentsPageGroup?.responses.map((response) => ({
          status: response.status,
          cacheControl: response.cacheControl,
          vary: response.vary,
          contentType: response.contentType,
          xVoidPages: response.xVoidPages,
          age: response.age,
          etag: response.etag,
          xCache: response.xCache,
          bodyBytes: response.bodyBytes,
        })) ?? [],
      };
      if (deploymentCompleteness) {
        printDiagnostics('management deployment data completeness', {
          selectedFields: deploymentSelection ?? [],
          presentFields: presentDeploymentFields,
          missingFields: missingDeploymentFields,
          steadyObservation: deploymentSteadyObservation,
        });
      }
      expect(deploymentsPageGroup?.requests).toBe(1);
      expect(deploymentsPageGroup?.aborted).toBe(0);
      expect(deploymentsPageGroup?.responses).toHaveLength(1);
      expect(requestsBeforeSteadyWindow).toBe(1);
      expect(missingDeploymentFields).not.toContain('tz');
      expect(deploymentResponseShape?.timezoneTypes).toEqual({ string: 1 });
      expect(deploymentSteadyObservation?.additionalIdenticalRequests).toBe(0);
      const deploymentRow = page.locator('tr').filter({ hasText: deploymentId });
      await deploymentRow.getByRole('link', { name: deploymentId, exact: true }).waitFor({
        timeout: 5_000,
      });
      expect(await deploymentRow.getByRole('link', { name: deploymentId, exact: true }).count()).toBe(1);
      expect(await deploymentRow.textContent()).toContain('pending');
      expect(await deploymentRow.textContent()).toContain(deploymentSource);
      await Promise.all([
        page.waitForURL(`${browserControlOrigin}/admin/deployments/${deploymentId}`, {
          timeout: 10_000,
        }),
        deploymentRow.getByRole('link', { name: deploymentId, exact: true }).click(),
      ]);
      await page.getByRole('heading', { name: `Deployment ${deploymentId}` }).waitFor({
        timeout: 5_000,
      });
      expect(await page.getByText(deploymentSource, { exact: true }).count()).toBe(1);
      expect(await page.getByText('pending', { exact: true }).count()).toBe(1);
      expect(await page.getByRole('link', { name: seededProject.slug, exact: true }).count()).toBe(1);
      expect(fateRequestBodies.some((body) => body.includes(`/admin/deployments/${deploymentId}`))).toBe(true);
      if (expectedNativeManifest) {
        expect(await page.getByRole('cell', { name: '1 included: 0001_fixture.sql' }).count()).toBe(1);
        const manifestCard = page
          .locator('.void-admin-card')
          .filter({ has: page.getByRole('heading', { name: 'Manifest', exact: true }) });
        const rawJsonTrigger = manifestCard.getByRole('button', { name: 'Raw JSON', exact: true });
        expect(await rawJsonTrigger.getAttribute('aria-expanded')).toBe('false');
        await rawJsonTrigger.click();
        const rawJson = manifestCard.locator('pre');
        await rawJson.waitFor({ state: 'visible' });
        const rawText = await rawJson.textContent();
        expect(JSON.parse(rawText ?? 'null')).toEqual(JSON.parse(expectedNativeManifest));
        expect(rawText).toContain('"runtimeId"');
        expect(rawText).toContain('"migrations"');
      }
      await page.reload();
      await page.getByRole('heading', { name: `Deployment ${deploymentId}` }).waitFor();
      await page.goBack();
      await page.getByRole('heading', { name: 'Deployments' }).waitFor();
      expect(page.url()).toBe(`${browserControlOrigin}/admin/deployments`);
      await page.goBack();
      await page.getByRole('heading', { name: 'Projects' }).waitFor();
      expect(page.url()).toBe(`${browserControlOrigin}/admin/projects`);
      const accountMenuButton = page.getByRole('button', {
        name: persistedAdmin.login,
        exact: true,
      });
      expect(await accountMenuButton.count()).toBe(1);
      if (browserLogoutMode === 'pointer') {
        const pointerMenuTopology = () => page.evaluate(() => {
          const isVisible = (element: Element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const rectOf = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          };
          return {
            path: location.pathname,
            viewport: { width: innerWidth, height: innerHeight },
            clientWidth: document.documentElement.clientWidth,
            triggers: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).map((button) => ({
              id: button.id,
              text: button.innerText.trim(),
              expanded: button.getAttribute('aria-expanded'),
              controls: button.getAttribute('aria-controls'),
              visible: isVisible(button),
              rect: rectOf(button),
            })),
            menus: Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).map((menu) => ({
              id: menu.id,
              label: menu.getAttribute('aria-label'),
              visible: isVisible(menu),
              ariaHidden: menu.getAttribute('aria-hidden'),
              popoverOpen: menu.closest<HTMLElement>('[popover]')?.matches(':popover-open') ?? null,
              rect: rectOf(menu),
              rows: Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => ({
                text: item.innerText.trim(),
                visible: isVisible(item),
                rect: rectOf(item),
                focused: item === document.activeElement,
              })),
            })),
          };
        });
        const topologyBeforeOpen = await pointerMenuTopology();
        await accountMenuButton.click({ timeout: 5_000 });
        try {
          await page.waitForFunction(
            (login) => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).some((button) => {
              const style = getComputedStyle(button);
              const rect = button.getBoundingClientRect();
              return button.innerText.trim() === login && button.getAttribute('aria-expanded') === 'true' &&
                style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            }),
            persistedAdmin.login,
            { timeout: 5_000 },
          );
        } catch (error) {
          const topologyAfterOpen = await pointerMenuTopology();
          console.error(`[management pointer menu open] ${JSON.stringify({ before: topologyBeforeOpen, after: topologyAfterOpen, pageErrors: browserErrors })}`);
          throw error;
        }
        const topologyAfterOpen = await pointerMenuTopology();
        console.error(`[management pointer menu topology] ${JSON.stringify({ before: topologyBeforeOpen, after: topologyAfterOpen })}`);
        const menuId = await accountMenuButton.getAttribute('aria-controls');
        if (!menuId) throw new Error('account_menu_control_id_missing_after_open');
        const accountMenu = page.locator(`[id="${menuId}"]`);
        const logoutMenuItem = accountMenu.getByRole('menuitem', { name: 'Log out', exact: true });
        await logoutMenuItem.waitFor({ state: 'visible', timeout: 5_000 });
        const initialMenuItemBox = await logoutMenuItem.boundingBox();
        if (!initialMenuItemBox) throw new Error('logout_menu_item_has_no_visible_box');
        await page.mouse.move(
          initialMenuItemBox.x + initialMenuItemBox.width / 2,
          initialMenuItemBox.y + initialMenuItemBox.height / 2,
        );
        await page.waitForFunction(
          async (id) => {
            const menu = document.getElementById(id);
            const item = menu?.querySelector<HTMLElement>('[role="menuitem"]');
            if (!item || item !== document.activeElement) return false;
            const before = item.getBoundingClientRect();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const currentMenu = document.getElementById(id);
            const currentItem = currentMenu?.querySelector<HTMLElement>('[role="menuitem"]');
            const after = currentItem?.getBoundingClientRect();
            return Boolean(
              currentItem === item && after &&
              before.x === after.x && before.y === after.y &&
              before.width === after.width && before.height === after.height,
            );
          },
          menuId,
          { timeout: 5_000 },
        );
        const stableMenuItemBox = await logoutMenuItem.boundingBox();
        if (!stableMenuItemBox) throw new Error('logout_menu_item_detached_before_pointer_release');
        await page.mouse.move(
          stableMenuItemBox.x + stableMenuItemBox.width / 2,
          stableMenuItemBox.y + stableMenuItemBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await accountMenuButton.press('ArrowDown', { timeout: 5_000 });
        const logoutMenuItem = page.getByRole('menuitem', { name: 'Log out', exact: true });
        await logoutMenuItem.waitFor({ state: 'visible', timeout: 5_000 });
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some(
            (item) => item.innerText.trim() === 'Log out' && item === document.activeElement,
          ),
          undefined,
          { timeout: 5_000 },
        );
        await page.keyboard.press('Enter');
      }
      await page.waitForURL(`${browserControlOrigin}/admin/login`);
      expect((await page.context().cookies(browserControlOrigin)).some((cookie) => cookie.name === 'admin_token')).toBe(false);
      expect(await page.getByRole('heading', { name: /^Sign in to administer / }).count()).toBe(1);
      await Promise.all([
        page.waitForURL((url) => url.origin === browserIssuer && url.pathname === '/authorize'),
        page.getByRole('link', { name: 'Sign in with Company SSO' }).click(),
      ]);
      await page.getByRole('button', { name: 'Sign in as test owner' }).click();
      await page.waitForURL(`${browserControlOrigin}/admin/`);
      expect(await page.getByRole('heading', { name: 'Dashboard', exact: true }).count()).toBe(1);
      expect((await page.context().cookies(browserControlOrigin)).some((cookie) => cookie.name === 'admin_token')).toBe(true);
      await Promise.allSettled(fateResponseTasks);
      printDiagnostics('management fate journey diagnostics');
      expect(fateRequestCap).toBeNull();
      expect(browserErrors).toEqual([]);

      expect(discoveryRequests).toBe(1);
      expect(authorizationRequests).toBe(2);
      expect(tokenRequests).toBe(2);
      expect(keyRequests).toBeGreaterThanOrEqual(1);
      expect(providerFailure).toBeUndefined();
      expect(await env.db.select().from(platformAuthSettings)).toHaveLength(1);
      expect(await env.db.select().from(platformAuthSettings)).toEqual(authSettingsAfterConfirmation);
      expect(await env.db.select().from(platformHumanSessions)).toHaveLength(2);
      expect(await env.db.select().from(platformAuthBootstrap)).toEqual(bootstrapStateAfterConfirmation);
      const finalIdentities = await env.db.select().from(platformLoginIdentities);
      expect(finalIdentities).toHaveLength(1);
      expect(finalIdentities).toMatchObject([
        expect.objectContaining({
          user_id: seed.operatorId,
          issuer: browserIssuer,
          subject: 'casimir-owner-subject',
        }),
      ]);
      const finalUsers = await env.db.select().from(users);
      expect(finalUsers).toHaveLength(1);
      expect(finalUsers).toMatchObject([
        expect.objectContaining({
          id: seed.operatorId,
          provider: 'casimir-local',
          provider_id: identity.installationId,
          role: 'admin',
        }),
      ]);
      expect(await env.db.select().from(projects)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: seed.projectId, user_id: seed.operatorId }),
          expect.objectContaining({ id: secondaryProject.id, user_id: seed.operatorId }),
        ]),
      );
      browserEvidenceStatus = 'passed';

    } catch (error) {
      browserEvidenceStatus = 'failed';
      browserEvidenceErrorName = error instanceof Error ? error.name : typeof error;
      throw error;
    } finally {
      lifecycleGate?.releaseAll();
      if (lifecycleGate) {
        await Promise.allSettled(lifecycleGate.requests.map((request) => request.delivered));
      }
      await browser?.close();
      if (controlListening) {
        await new Promise<void>((resolve) => control.close(() => resolve()));
      }
      if (idpListening) {
        await new Promise<void>((resolve) => idp.close(() => resolve()));
      }
      if (compiledMain && compiledMain.exitCode === null && compiledMain.signalCode === null) {
        compiledMain.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            compiledMain?.kill('SIGKILL');
            resolve();
          }, 5000);
          compiledMain?.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await browserEvidenceFinalizer?.({
        status: browserEvidenceStatus,
        ...(browserEvidenceErrorName ? { errorName: browserEvidenceErrorName } : {}),
      });
    }
  }, 60_000);
});
