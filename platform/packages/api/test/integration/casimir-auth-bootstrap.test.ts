/**
 * Exercises the original bootstrap seam for an existing C1 administrator.
 * The identity fixture is the post-verification result consumed by the original
 * stage/confirm flow; provider-token verification remains covered by the OIDC
 * route suite.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { CompanyIdentity } from '../../src/auth/sessions.ts';
import {
  confirmBootstrapIdentity,
  initializeAuthentication,
  stageBootstrapIdentity,
  type BootstrapOptions,
  verifyBootstrapCode,
} from '../../src/auth/bootstrap.ts';
import { validateHumanSession } from '../../src/auth/sessions.ts';
import { AuthenticationConfigurationError } from '../../src/auth/configuration.ts';
import { verifyJwt } from '../../src/auth/jwt.ts';
import { hashLoginProof, randomLoginProof } from '../../src/auth/proofs.ts';
import type { Db } from '../../src/db.ts';
import { createUser } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import type { PlatformOidcIdentity } from '../../src/auth/identity-types.ts';
import { createCasimirBootstrapOptions } from '../../src/casimir/management/bootstrap-policy.ts';
import { createProject } from '../../src/db/projects.ts';
import {
  operatorEvents,
  platformAuthBootstrap,
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
  platformLoginIdentities,
  projects,
  users,
} from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

const apiOrigin = 'https://api.bootstrap-example.com';
const issuer = 'https://identity.bootstrap-example.com';
const installationId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const foreignInstallationId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ownershipNonce = 'synthetic-owner-nonce-00000000000000000000000000000000';
const postgres = it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL));

function initializeWithOptions(
  db: Db,
  env: ApiEnv['Bindings'],
  input: unknown,
  apiOrigin: string,
  options: BootstrapOptions,
): ReturnType<typeof initializeAuthentication> {
  return initializeAuthentication(db, env, input, apiOrigin, options);
}

function confirmWithOptions(
  db: Db,
  env: ApiEnv['Bindings'],
  proof: string,
  companyIdentity: CompanyIdentity | undefined,
  options: BootstrapOptions,
): ReturnType<typeof confirmBootstrapIdentity> {
  return confirmBootstrapIdentity(db, env, proof, companyIdentity, options);
}

let env: TestEnv;
let seed: { operatorId: string; projectId: string };
let exactSeedOptions: BootstrapOptions;
let setupCode: string;

beforeAll(async () => {
  env = await setupEnv();
  // Match the installer-owned singleton shape; lifecycle tests must never use
  // an installation_id-only marker as proof of ownership.
  await env.db.execute(sql`
    CREATE TABLE IF NOT EXISTS __void_platform_installation (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      installation_id text NOT NULL,
      ownership_nonce text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      lifecycle_manifest jsonb
    )
  `);
  await env.db.execute(
    sql`ALTER TABLE __void_platform_installation ADD COLUMN IF NOT EXISTS ownership_nonce text NOT NULL DEFAULT 'test-owner-nonce'`,
  );
  await env.db.execute(
    sql`ALTER TABLE __void_platform_installation ADD COLUMN IF NOT EXISTS claimed_at timestamptz NOT NULL DEFAULT now()`,
  );
  await env.db.execute(
    sql`ALTER TABLE __void_platform_installation ADD COLUMN IF NOT EXISTS lifecycle_manifest jsonb`,
  );
});

afterAll(async () => {
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_install CASCADE`);
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_mvp_a CASCADE`);
  await env.db.execute(sql`DROP TABLE IF EXISTS __void_platform_installation`);
  await teardownEnv();
});

beforeEach(async () => {
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_install CASCADE`);
  await env.db.execute(sql`DROP SCHEMA IF EXISTS casimir_mvp_a CASCADE`);
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.db.execute(sql`
    INSERT INTO __void_platform_installation
      (singleton, installation_id, ownership_nonce, lifecycle_manifest)
    VALUES (true, ${installationId}, ${ownershipNonce}, NULL)
  `);

  // Seed the C1 operator/project identity using Void's real user/project
  // functions. Login/email are fixture values, not authorization predicates.
  // The ownership row below is synthetic; it is not a production migration.
  const operator = await createUser(
    env.db,
    'casimir-local',
    installationId,
    'local-operator',
    'operator@example.invalid',
    'admin',
  );
  const project = await createProject(env.db, operator.id, 'casimir-reference');
  seed = { operatorId: operator.id, projectId: project.id };
  exactSeedOptions = createCasimirBootstrapOptions({ installationId, operatorId: operator.id, ownershipNonce, projectId: project.id });
  await env.db.execute(sql`CREATE SCHEMA casimir_install`);
  await env.db.execute(sql`
    CREATE TABLE casimir_install.installation (
      id integer PRIMARY KEY CHECK (id = 1),
      installation_id text NOT NULL UNIQUE CHECK (installation_id ~ '^[a-f0-9]{32}$'),
      operator_id text NOT NULL REFERENCES users(id),
      project_id text NOT NULL REFERENCES projects(id),
      bundle_version text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('ready', 'stopped', 'maintenance', 'recovery_required')),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await env.db.execute(sql`
    INSERT INTO casimir_install.installation
      (id, installation_id, operator_id, project_id, bundle_version, phase)
    VALUES (1, ${installationId}, ${operator.id}, ${project.id}, 'c1.1', 'ready')
  `);
  await env.db.execute(sql`CREATE SCHEMA casimir_mvp_a`);
  await env.db.execute(sql`
    CREATE TABLE casimir_mvp_a.scope (
      id integer PRIMARY KEY CHECK (id = 1),
      project_id text REFERENCES projects(id) ON DELETE RESTRICT
    )
  `);
  await env.db.execute(sql`INSERT INTO casimir_mvp_a.scope(id, project_id) VALUES (1, ${project.id})`);
  setupCode = randomLoginProof();
});

function bindings(id = installationId): ApiEnv['Bindings'] {
  return { ...env, PLATFORM_INSTALLATION_ID: id } as unknown as ApiEnv['Bindings'];
}

async function setupInput() {
  return {
    connections: [
      {
        configuration: {
          id: 'company',
          kind: 'oidc',
          label: 'Company SSO',
          issuer,
          clientId: 'synthetic-client',
        },
        clientSecret: 'synthetic-client-secret',
      },
    ],
    administratorConnectionId: 'company',
    bootstrapCredentialHash: await hashLoginProof(setupCode),
    admission: { mode: 'restricted' },
    protection: null,
  };
}

async function resetSetupInput(clientId: string) {
  const input = await setupInput();
  input.connections[0]!.configuration.clientId = clientId;
  return { ...input, resetPending: true };
}

async function initializeSeed() {
  return initializeWithOptions(
    env.db,
    bindings(),
    await setupInput(),
    apiOrigin,
    exactSeedOptions,
  );
}

async function stageVerifiedProviderResult() {
  const pending = await verifyBootstrapCode(env.db, installationId, setupCode);
  const identity: PlatformOidcIdentity = {
    issuer,
    subject: 'synthetic-verified-subject',
    login: 'local-operator',
    email: 'operator@example.invalid',
    emailVerified: true,
    groups: [],
  };
  return stageBootstrapIdentity(env.db, {
    installationId,
    credentialHash: pending.credential_hash,
    connectionId: pending.connection_id,
    revision: 1,
    generation: 1,
    identity,
  });
}

async function expectNoInitializationWrites() {
  expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
  expect(await env.db.select().from(platformLoginConnections)).toHaveLength(0);
  expect(await env.db.select().from(platformAuthBootstrap)).toHaveLength(0);
}

async function expectNoConfirmedIdentityOrSession() {
  expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(0);
  expect(await env.db.select().from(platformHumanSessions)).toHaveLength(0);
}

async function expectSeedUnchanged() {
  const installation = await env.db.execute<{
    operator_id: string;
    project_id: string;
  }>(sql`SELECT operator_id, project_id FROM casimir_install.installation WHERE id = 1`);
  expect(installation.rows[0]).toEqual({ operator_id: seed.operatorId, project_id: seed.projectId });
  expect(await env.db.select().from(users)).toHaveLength(1);
  const [project] = await env.db.select().from(projects).where(eq(projects.id, seed.projectId));
  expect(project).toMatchObject({ id: seed.projectId, user_id: seed.operatorId, slug: 'casimir-reference' });
}

describe('original authentication bootstrap with a server-only C1 administrator policy', () => {
  it('keeps the upstream default refusal when users already exist', async () => {
    await expect(
      initializeAuthentication(env.db, bindings(), await setupInput(), apiOrigin),
    ).rejects.toMatchObject({ code: 'already_initialized' });

    await expectInitializationWritesToBeAbsentAfterClientSuppliedPolicy();
  });

  it('rejects C1 bootstrap when the original installation ownership row is missing', async () => {
    await env.db.execute(sql`DELETE FROM __void_platform_installation`);

    await expect(initializeSeed()).rejects.toMatchObject({ code: 'invalid_installation' });
    await expectNoInitializationWrites();
    await expectSeedUnchanged();
  });

  it('rejects a C1 installation record for another installation', async () => {
    await env.db.execute(
      sql`UPDATE casimir_install.installation SET installation_id = ${foreignInstallationId} WHERE id = 1`,
    );

    await expect(initializeSeed()).rejects.toMatchObject({ code: 'invalid_installation' });
    await expectNoInitializationWrites();
  });

  it('confirms a verified identity onto the exact seeded operator and returns the original admin session', async () => {
    await expect(initializeSeed()).resolves.toMatchObject({ setupPending: true });
    const proof = await stageVerifiedProviderResult();
    const confirmed = await confirmWithOptions(
      env.db,
      bindings(),
      proof,
      undefined,
      exactSeedOptions,
    );

    const payload = await verifyJwt(confirmed.token, env.JWT_SECRET, 'admin');
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ sub: seed.operatorId, aud: 'admin', sid: confirmed.session.id });
    expect(confirmed.session).toMatchObject({ user_id: seed.operatorId, audience: 'admin' });
    expect(await validateHumanSession(env.db, payload!, undefined)).toBe(true);
    expect(await env.db.select().from(platformLoginIdentities)).toMatchObject([
      { user_id: seed.operatorId, connection_id: 'company', issuer, subject: 'synthetic-verified-subject' },
    ]);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
    const events = await env.db.select().from(operatorEvents);
    expect(events.filter((event) => event.action === 'auth.bootstrap.initialize')).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.user_id === seed.operatorId && event.action === 'auth.bootstrap.confirm',
      ),
    ).toHaveLength(1);
    await expectSeedUnchanged();

    await expect(
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_setup_claim' });
  });

  postgres('allows only one concurrent confirmation for the same setup proof', async () => {
    await initializeSeed();
    const proof = await stageVerifiedProviderResult();

    const results = await Promise.allSettled([
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'invalid_setup_claim',
    });
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
    expect(
      (await env.db.select().from(operatorEvents)).filter(
        (event) => event.action === 'auth.bootstrap.confirm',
      ),
    ).toHaveLength(1);
    await expectSeedUnchanged();
  });

  it('replays a consumed matching setup after other users are added while still checking ownership', async () => {
    const input = await setupInput();
    await initializeWithOptions(env.db, bindings(), input, apiOrigin, exactSeedOptions);
    const proof = await stageVerifiedProviderResult();
    await confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions);
    await createUser(env.db, 'github', 'unrelated-subject', 'unrelated-user', null, 'user');

    await expect(
      initializeWithOptions(env.db, bindings(), input, apiOrigin, exactSeedOptions),
    ).resolves.toEqual({ setupPending: false, expiresAt: null });
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);

    await env.db.execute(
      sql`UPDATE __void_platform_installation SET installation_id = ${foreignInstallationId} WHERE singleton = true`,
    );
    await expect(
      initializeWithOptions(env.db, bindings(), input, apiOrigin, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_installation' });
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
  });

  it('replays completed setup after the seed role and reference-project ownership change', async () => {
    const input = await setupInput();
    await initializeWithOptions(env.db, bindings(), input, apiOrigin, exactSeedOptions);
    const proof = await stageVerifiedProviderResult();
    await confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions);
    const secondUser = await createUser(
      env.db,
      'github',
      'unrelated-subject',
      'unrelated-user',
      null,
      'user',
    );
    await env.db.update(users).set({ role: 'user' }).where(eq(users.id, seed.operatorId));
    await env.db
      .update(projects)
      .set({ user_id: secondUser.id })
      .where(eq(projects.id, seed.projectId));
    const eventsBeforeReplay = await env.db.select().from(operatorEvents);

    await expect(
      initializeWithOptions(env.db, bindings(), input, apiOrigin, exactSeedOptions),
    ).resolves.toEqual({ setupPending: false, expiresAt: null });

    const [operatorAfterReplay] = await env.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, seed.operatorId));
    const [projectAfterReplay] = await env.db
      .select({ user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, seed.projectId));
    expect(operatorAfterReplay?.role).toBe('user');
    expect(projectAfterReplay?.user_id).toBe(secondUser.id);
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
    expect(await env.db.select().from(operatorEvents)).toEqual(eventsBeforeReplay);
  });

  it('allows reset only for an unconsumed C1 setup with no linked identity or session', async () => {
    const initialInput = await setupInput();
    await initializeWithOptions(env.db, bindings(), initialInput, apiOrigin, exactSeedOptions);
    const obsoleteProof = await stageVerifiedProviderResult();
    const [initialBootstrap] = await env.db.select().from(platformAuthBootstrap);
    const replacementInput = await resetSetupInput('replacement-client');

    await expect(
      initializeWithOptions(env.db, bindings(), replacementInput, apiOrigin, exactSeedOptions),
    ).resolves.toMatchObject({ setupPending: true });

    const [replacementBootstrap] = await env.db.select().from(platformAuthBootstrap);
    expect(replacementBootstrap?.request_hash).not.toBe(initialBootstrap?.request_hash);
    expect(replacementBootstrap?.claim_hash).toBeNull();
    expect(replacementBootstrap?.pending_identity).toBeNull();
    await expect(
      confirmWithOptions(env.db, bindings(), obsoleteProof, undefined, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_setup_claim' });
    await expectNoConfirmedIdentityOrSession();
    await expectSeedUnchanged();
  });

  it('does not reset unknown legacy settings without an unconsumed setup claim', async () => {
    await env.db.insert(platformAuthSettings).values({
      admission: { mode: 'restricted' },
      protection: null,
      sessions_required: true,
    });
    const [legacySettings] = await env.db.select().from(platformAuthSettings);
    const resetInput = await resetSetupInput('legacy-reset-attempt');

    await expect(
      initializeWithOptions(env.db, bindings(), resetInput, apiOrigin, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'already_initialized' });
    expect(await env.db.select().from(platformAuthSettings)).toEqual([legacySettings]);
    expect(await env.db.select().from(platformLoginConnections)).toHaveLength(0);
    expect(await env.db.select().from(platformAuthBootstrap)).toHaveLength(0);
    await expectSeedUnchanged();
  });

  it('does not let resetPending reopen a consumed C1 setup', async () => {
    await initializeSeed();
    const proof = await stageVerifiedProviderResult();
    await confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions);
    const resetInput = await resetSetupInput('consumed-reset-attempt');

    await expect(
      initializeWithOptions(env.db, bindings(), resetInput, apiOrigin, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'already_initialized' });
    expect(await env.db.select().from(platformLoginIdentities)).toHaveLength(1);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(1);
  });

  it('rejects an extra user instead of attaching bootstrap to a non-singleton user set', async () => {
    await createUser(env.db, 'github', 'unrelated-subject', 'unrelated-user', null, 'user');
    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
    await expectSeedUnchangedExceptForAdditionalUser();
  });

  it('rejects a changed C1 operator instead of moving the seeded project to another user', async () => {
    const other = await createUser(
      env.db,
      'casimir-local',
      'cccccccccccccccccccccccccccccccc',
      'other-operator',
      'other@example.invalid',
      'admin',
    );
    await env.db.execute(
      sql`UPDATE casimir_install.installation SET operator_id = ${other.id} WHERE id = 1`,
    );

    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
    const installation = await env.db.execute<{ operator_id: string; project_id: string }>(
      sql`SELECT operator_id, project_id FROM casimir_install.installation WHERE id = 1`,
    );
    expect(installation.rows[0]).toEqual({ operator_id: other.id, project_id: seed.projectId });
    const [project] = await env.db.select().from(projects).where(eq(projects.id, seed.projectId));
    expect(project?.user_id).toBe(seed.operatorId);
  });

  it('does not resolve the seeded administrator after the reference project changes owners', async () => {
    const other = await createUser(
      env.db,
      'github',
      'unrelated-subject',
      'unrelated-user',
      null,
      'user',
    );
    await env.db.execute(sql`UPDATE projects SET user_id = ${other.id} WHERE id = ${seed.projectId}`);
    const resolved = await env.db.transaction((transaction) =>
      exactSeedOptions.existingAdministrator!(transaction, installationId),
    );

    expect(resolved).toBeNull();
    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
  });

  it('rejects a seed user whose provider identity no longer matches the C1 installation', async () => {
    await env.db.update(users).set({ provider: 'github' }).where(eq(users.id, seed.operatorId));
    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
  });

  it('rejects the only seeded user after its administrator role is removed', async () => {
    await env.db.update(users).set({ role: 'user' }).where(eq(users.id, seed.operatorId));
    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
    const [operator] = await env.db.select().from(users).where(eq(users.id, seed.operatorId));
    expect(operator?.role).toBe('user');
    await expectSeedUnchanged();
  });

  it('rejects a suspended seeded administrator', async () => {
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, seed.operatorId));
    await expect(initializeSeed()).rejects.toBeInstanceOf(AuthenticationConfigurationError);
    await expectNoInitializationWrites();
  });

  it('rejects initialization when the supplied installation id is foreign', async () => {
    await expect(
      initializeWithOptions(
        env.db,
        bindings(foreignInstallationId),
        await setupInput(),
        apiOrigin,
        exactSeedOptions,
      ),
    ).rejects.toMatchObject({ code: 'invalid_installation' });
    await expectNoInitializationWrites();
    await expectSeedUnchanged();
  });

  it('rejects an expired setup credential before staging provider identity', async () => {
    await initializeSeed();
    await env.db
      .update(platformAuthBootstrap)
      .set({ expires_at: new Date(0).toISOString() })
      .where(eq(platformAuthBootstrap.singleton, true));

    await expect(verifyBootstrapCode(env.db, installationId, setupCode)).rejects.toMatchObject({
      code: 'invalid_setup_code',
    });
    await expectNoConfirmedIdentityOrSession();
    await expectSeedUnchanged();
  });

  it('rejects an expired staged identity proof without linking or minting a session', async () => {
    await initializeSeed();
    const proof = await stageVerifiedProviderResult();
    const [pending] = await env.db
      .select()
      .from(platformAuthBootstrap)
      .where(eq(platformAuthBootstrap.singleton, true));
    expect(pending?.pending_identity).not.toBeNull();
    await env.db
      .update(platformAuthBootstrap)
      .set({
        pending_identity: {
          ...pending!.pending_identity!,
          expiresAt: new Date(0).toISOString(),
        },
      })
      .where(eq(platformAuthBootstrap.singleton, true));

    await expect(
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_setup_claim' });
    await expectNoConfirmedIdentityOrSession();
    await expectSeedUnchanged();
  });

  it('rejects provider confirmation after the configured connection generation changes', async () => {
    await initializeSeed();
    const proof = await stageVerifiedProviderResult();
    await env.db
      .update(platformLoginConnections)
      .set({ revision: 2, generation: 2 })
      .where(eq(platformLoginConnections.id, 'company'));

    await expect(
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_setup_claim' });
    await expectNoConfirmedIdentityOrSession();
    await expectSeedUnchanged();
  });

  it('does not reassign a provider identity already linked to another user', async () => {
    await initializeSeed();
    const proof = await stageVerifiedProviderResult();
    const other = await createUser(
      env.db,
      'github',
      'unrelated-subject',
      'unrelated-user',
      null,
      'user',
    );
    await env.db.insert(platformLoginIdentities).values({
      id: 'existing-provider-identity',
      user_id: other.id,
      connection_id: 'company',
      issuer,
      subject: 'synthetic-verified-subject',
    });

    await expect(
      confirmWithOptions(env.db, bindings(), proof, undefined, exactSeedOptions),
    ).rejects.toMatchObject({ code: 'invalid_setup_claim' });
    const [identity] = await env.db
      .select()
      .from(platformLoginIdentities)
      .where(eq(platformLoginIdentities.id, 'existing-provider-identity'));
    expect(identity?.user_id).toBe(other.id);
    expect(await env.db.select().from(platformHumanSessions)).toHaveLength(0);
    await expectSeedUnchangedExceptForAdditionalUser();
  });
});

async function expectInitializationWritesToBeAbsentAfterClientSuppliedPolicy() {
  const clientSuppliedPolicy = {
    ...(await setupInput()),
    existingAdministrator: { operatorId: seed.operatorId },
  };
  await expect(
    initializeAuthentication(env.db, bindings(), clientSuppliedPolicy, apiOrigin),
  ).rejects.toBeInstanceOf(AuthenticationConfigurationError);
  await expectNoInitializationWrites();
  await expectSeedUnchanged();
}

async function expectSeedUnchangedExceptForAdditionalUser() {
  const installation = await env.db.execute<{
    operator_id: string;
    project_id: string;
  }>(sql`SELECT operator_id, project_id FROM casimir_install.installation WHERE id = 1`);
  expect(installation.rows[0]).toEqual({ operator_id: seed.operatorId, project_id: seed.projectId });
  expect(await env.db.select().from(users)).toHaveLength(2);
  const [project] = await env.db.select().from(projects).where(eq(projects.id, seed.projectId));
  expect(project).toMatchObject({ id: seed.projectId, user_id: seed.operatorId, slug: 'casimir-reference' });
}
