import { parsePlatformInstallationManifest } from '@void/platform';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db.ts';
import { assertControlSchema } from '../lifecycle/control-migrations.ts';
import { isAdminSuspended } from '../../suspension.ts';
import { lockAuthSettings } from '../../auth/configuration.ts';
import { lockPlanCatalog } from '../../plans.ts';
import {
  managementOwnerMatches,
  prepareCasimirManagementOwner,
  publishCasimirManagementConfig,
  readCasimirManagementConfig,
  readCasimirManagementOwner,
  validateCasimirManagementOwner,
  type CasimirManagementConfig,
  type CasimirManagementOwner,
} from './management-files.ts';
import {
  oauthAccounts,
  operatorSessions,
  platformAuthAttempts,
  platformAuthBootstrap,
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginRevisions,
  platformLoginTests,
  projects,
  users,
} from '../../schema.ts';

export {
  prepareCasimirManagementOwner,
  publishCasimirManagementConfig,
  readCasimirManagementConfig,
};
export type { CasimirManagementConfig, CasimirManagementOwner };

type InstallationRow = {
  installation_id: string;
  operator_id: string;
  project_id: string;
  bundle_version: string;
  phase: string;
};

type ClaimRow = {
  installation_id: string;
  ownership_nonce: string;
  lifecycle_manifest: unknown;
};

async function bindOwnerToSeed(
  state: string,
  candidate: CasimirManagementOwner,
  operatorId: string,
  projectId: string,
): Promise<CasimirManagementOwner> {
  const stored = await readCasimirManagementOwner(state);
  if (!managementOwnerMatches(stored, candidate)) throw new Error('management_owner_conflict');
  if (stored.operatorId !== operatorId || stored.projectId !== projectId) {
    throw new Error('management_seed_identity_conflict');
  }
  return stored;
}

async function hasAuthenticationState(transaction: Db): Promise<boolean> {
  const state = await transaction.execute<{ present: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM platform_auth_settings) OR
      EXISTS (SELECT 1 FROM platform_auth_attempts) OR
      EXISTS (SELECT 1 FROM platform_auth_bootstrap) OR
      EXISTS (SELECT 1 FROM platform_login_connections) OR
      EXISTS (SELECT 1 FROM platform_login_revisions) OR
      EXISTS (SELECT 1 FROM platform_login_identities) OR
      EXISTS (SELECT 1 FROM platform_login_tests) OR
      EXISTS (SELECT 1 FROM platform_human_sessions) OR
      EXISTS (SELECT 1 FROM operator_sessions) OR
      EXISTS (SELECT 1 FROM oauth_accounts) AS present
  `);
  return state.rows[0]?.present === true;
}

async function ensureOwnerTable(transaction: Db): Promise<void> {
  await transaction.execute(sql`
    CREATE TABLE IF NOT EXISTS public.__void_platform_installation (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      installation_id text NOT NULL,
      ownership_nonce text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      lifecycle_manifest jsonb
    )
  `);
  await transaction.execute(sql`
    ALTER TABLE public.__void_platform_installation
    ADD COLUMN IF NOT EXISTS lifecycle_manifest jsonb
  `);
}

async function tryOriginalLifecycleLock(
  transaction: Db,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  const result = await transaction.execute<{ acquired: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      'void-platform-lifecycle-v1:' || ${installationId} || ':' || ${ownershipNonce}, 0
    )) AS acquired
  `);
  if (result.rows[0]?.acquired !== true) throw new Error('lifecycle_busy');
}

function validateClaimManifest(claim: ClaimRow): void {
  if (claim.lifecycle_manifest === null || claim.lifecycle_manifest === undefined) return;
  try {
    const manifest = parsePlatformInstallationManifest(claim.lifecycle_manifest);
    if (manifest.id !== claim.installation_id || manifest.ownershipNonce !== claim.ownership_nonce) {
      throw new Error('management_claim_manifest_conflict');
    }
  } catch {
    throw new Error('management_claim_manifest_invalid');
  }
}

/**
 * Adopts only the exact, migrated C1 seed into Void's original installation
 * ownership table. The owner record is bound to both seed IDs before the DB
 * transaction commits, so a lost result can be retried without re-adoption.
 */
export async function adoptCasimirManagementOwner(
  db: Db,
  candidate: CasimirManagementOwner,
  version: string,
  state: string,
): Promise<CasimirManagementConfig> {
  const owner = validateCasimirManagementOwner(candidate);
  const catalogVersion = version;
  return db.transaction(async (transaction) => {
    const installationResult = await transaction.execute<InstallationRow>(sql`
      SELECT installation_id, operator_id, project_id, bundle_version, phase
      FROM casimir_install.installation WHERE id = 1 FOR UPDATE
    `);
    const installation = installationResult.rows[0];
    if (
      !installation ||
      installation.installation_id !== owner.installationId ||
      installation.bundle_version !== catalogVersion ||
      installation.phase !== 'ready'
    ) {
      throw new Error('management_installation_unavailable');
    }
    await assertControlSchema(transaction, catalogVersion);

    const scopeResult = await transaction.execute<{ project_id: string | null }>(sql`
      SELECT project_id FROM casimir_mvp_a.scope WHERE id = 1 FOR UPDATE
    `);
    if (scopeResult.rows[0]?.project_id !== installation.project_id) {
      throw new Error('management_scope_identity_conflict');
    }

    const ownerTable = await transaction.execute<{ present: boolean }>(sql`
      SELECT to_regclass('public.__void_platform_installation') IS NOT NULL AS present
    `);
    let observedClaim: ClaimRow | undefined;
    if (ownerTable.rows[0]?.present) {
      const claimResult = await transaction.execute<ClaimRow>(sql`
        SELECT installation_id, ownership_nonce, lifecycle_manifest
        FROM public.__void_platform_installation WHERE singleton = true
      `);
      observedClaim = claimResult.rows[0];
    }
    if (
      observedClaim &&
      (observedClaim.installation_id !== owner.installationId ||
        observedClaim.ownership_nonce !== owner.ownershipNonce)
    ) {
      throw new Error('management_claim_conflict');
    }
    if (observedClaim) validateClaimManifest(observedClaim);

    // Original lifecycle code takes this advisory lock before updating its
    // ownership row. Try it before any row lock or DDL to preserve that order.
    await tryOriginalLifecycleLock(transaction, owner.installationId, owner.ownershipNonce);
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('void-platform-installation-ownership-v1'))`,
    );
    if (!ownerTable.rows[0]?.present) await ensureOwnerTable(transaction);
    const lockedClaimResult = await transaction.execute<ClaimRow>(sql`
      SELECT installation_id, ownership_nonce, lifecycle_manifest
      FROM public.__void_platform_installation WHERE singleton = true FOR UPDATE
    `);
    const existingClaim = lockedClaimResult.rows[0];
    if (
      existingClaim &&
      (existingClaim.installation_id !== owner.installationId ||
        existingClaim.ownership_nonce !== owner.ownershipNonce)
    ) {
      throw new Error('management_claim_conflict');
    }
    if (observedClaim && !existingClaim) throw new Error('management_claim_conflict');
    if (existingClaim) validateClaimManifest(existingClaim);
    await lockPlanCatalog(transaction);
    const authSettings = await lockAuthSettings(transaction);
    await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    await transaction.execute(sql`LOCK TABLE ${projects} IN SHARE ROW EXCLUSIVE MODE`);

    const userRows = await transaction.execute<{
      id: string;
      provider: string;
      provider_id: string;
      role: string;
      suspended_reason: string | null;
    }>(sql`
      SELECT id, provider, provider_id, role, suspended_reason
      FROM public.users ORDER BY id FOR UPDATE
    `);
    const projectRows = await transaction.execute<{ id: string; user_id: string; slug: string }>(sql`
      SELECT id, user_id, slug FROM public.projects ORDER BY id FOR UPDATE
    `);

    if (!existingClaim) {
      if (authSettings || (await hasAuthenticationState(transaction))) {
        throw new Error('management_existing_auth_state');
      }
      if (
        userRows.rows.length !== 1 ||
        userRows.rows[0]?.id !== installation.operator_id ||
        userRows.rows[0]?.provider !== 'casimir-local' ||
        userRows.rows[0]?.provider_id !== owner.installationId ||
        userRows.rows[0]?.role !== 'admin' ||
        isAdminSuspended(userRows.rows[0]?.suspended_reason ?? null) ||
        projectRows.rows.length !== 1 ||
        projectRows.rows[0]?.id !== installation.project_id ||
        projectRows.rows[0]?.user_id !== installation.operator_id ||
        projectRows.rows[0]?.slug !== 'casimir-reference'
      ) {
        throw new Error('management_seed_identity_conflict');
      }
    } else if (
      owner.operatorId !== installation.operator_id ||
      owner.projectId !== installation.project_id
    ) {
      throw new Error('management_seed_identity_conflict');
    }

    const boundOwner = await bindOwnerToSeed(
      state,
      owner,
      installation.operator_id,
      installation.project_id,
    );
    if (!existingClaim) {
      await transaction.execute(sql`
        INSERT INTO public.__void_platform_installation
          (singleton, installation_id, ownership_nonce)
        VALUES (true, ${owner.installationId}, ${owner.ownershipNonce})
      `);
    }
    return boundOwner;
  });
}

