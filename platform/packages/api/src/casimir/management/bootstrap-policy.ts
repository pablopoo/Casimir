import { parsePlatformInstallationManifest } from '@void/platform';
import { sql } from 'drizzle-orm';
import { AuthenticationConfigurationError } from '../../auth/configuration.ts';
import type { BootstrapOptions } from '../../auth/bootstrap.ts';
import type { Db } from '../../db.ts';
import type { CasimirManagementConfig } from './enrollment.ts';
import { isAdminSuspended } from '../../suspension.ts';

type CasimirOwnershipRow = {
  project_id: string;
  ownership_nonce: string;
  lifecycle_manifest: unknown;
  phase: string;
};

type CasimirClaimLockRow = Pick<CasimirOwnershipRow, 'ownership_nonce' | 'lifecycle_manifest'>;

type CasimirSeedRow = {
  role: string;
  suspended_reason: string | null;
};

function invalidInstallation(): AuthenticationConfigurationError {
  return new AuthenticationConfigurationError(
    'The authentication setup belongs to another installation.',
    'invalid_installation',
    403,
  );
}

function unavailableInstallation(): AuthenticationConfigurationError {
  return new AuthenticationConfigurationError(
    'Authentication setup is unavailable while this installation is in maintenance or recovery.',
    'management_installation_unavailable',
    409,
  );
}

function lifecycleBusy(): AuthenticationConfigurationError {
  return new AuthenticationConfigurationError(
    'Another installation lifecycle operation is active. Finish it before configuring authentication.',
    'lifecycle_busy',
    409,
  );
}

function verifyClaimManifest(
  row: Pick<CasimirOwnershipRow, 'ownership_nonce' | 'lifecycle_manifest'>,
  installationId: string,
): void {
  if (row.lifecycle_manifest === null || row.lifecycle_manifest === undefined) return;
  try {
    const manifest = parsePlatformInstallationManifest(row.lifecycle_manifest);
    if (manifest.id !== installationId || manifest.ownershipNonce !== row.ownership_nonce) {
      throw invalidInstallation();
    }
  } catch (error) {
    if (error instanceof AuthenticationConfigurationError) throw error;
    throw invalidInstallation();
  }
}

/** Lock admission before any original plan, auth, user, or project lock. */
async function lockCasimirManagementAdmission(
  transaction: Db,
  requestedInstallationId: string,
  input: Pick<CasimirManagementConfig, 'installationId' | 'ownershipNonce' | 'operatorId' | 'projectId'>,
): Promise<void> {
  if (
    requestedInstallationId !== input.installationId ||
    !/^[a-f0-9]{32}$/.test(input.installationId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.ownershipNonce) ||
    !/^user_[a-z0-9]{12}$/.test(input.operatorId) ||
    !/^proj_[a-z0-9]{12}$/.test(input.projectId)
  ) {
    throw invalidInstallation();
  }

  const installResult = await transaction.execute<{
    installation_id: string;
    operator_id: string;
    project_id: string;
    phase: string;
  }>(sql`
    SELECT installation_id, operator_id, project_id, phase
    FROM casimir_install.installation WHERE id = 1 FOR UPDATE
  `);
  const installation = installResult.rows[0];
  if (
    !installation || installation.installation_id !== input.installationId ||
    installation.operator_id !== input.operatorId || installation.project_id !== input.projectId
  ) {
    throw invalidInstallation();
  }
  if (installation.phase !== 'ready') throw unavailableInstallation();

  const scopeResult = await transaction.execute<{ project_id: string | null }>(sql`
    SELECT project_id FROM casimir_mvp_a.scope WHERE id = 1 FOR UPDATE
  `);
  if (scopeResult.rows[0]?.project_id !== input.projectId) throw invalidInstallation();

  const observedClaimResult = await transaction.execute<{
    installation_id: string;
    ownership_nonce: string;
    lifecycle_manifest: unknown;
  }>(sql`
    SELECT installation_id, ownership_nonce, lifecycle_manifest
    FROM public.__void_platform_installation
    WHERE singleton = true
  `);
  const observedClaim = observedClaimResult.rows[0];
  if (
    !observedClaim ||
    observedClaim.installation_id !== input.installationId ||
    observedClaim.ownership_nonce !== input.ownershipNonce
  ) {
    throw invalidInstallation();
  }
  verifyClaimManifest(observedClaim, input.installationId);

  const lifecycleLock = await transaction.execute<{ acquired: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      'void-platform-lifecycle-v1:' || ${input.installationId} || ':' || ${input.ownershipNonce}, 0
    )) AS acquired
  `);
  if (lifecycleLock.rows[0]?.acquired !== true) throw lifecycleBusy();

  const claimResult = await transaction.execute<CasimirClaimLockRow>(sql`
    SELECT ownership_nonce, lifecycle_manifest
    FROM public.__void_platform_installation
    WHERE singleton = true AND installation_id = ${input.installationId}
    FOR UPDATE
  `);
  const claim = claimResult.rows[0];
  if (!claim || claim.ownership_nonce !== input.ownershipNonce) throw invalidInstallation();
  verifyClaimManifest(claim, input.installationId);
}

async function readCasimirOwnership(
  transaction: Db,
  requestedInstallationId: string,
  input: Pick<CasimirManagementConfig, 'installationId' | 'ownershipNonce' | 'operatorId'>,
): Promise<CasimirOwnershipRow | null> {
  if (
    requestedInstallationId !== input.installationId ||
    !/^[a-f0-9]{32}$/.test(input.installationId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.ownershipNonce) ||
    !input.operatorId
  ) {
    return null;
  }

  const result = await transaction.execute<CasimirOwnershipRow>(sql`
    SELECT
      installation.project_id,
      original.ownership_nonce,
      original.lifecycle_manifest,
      installation.phase
    FROM casimir_install.installation AS installation
    JOIN public.__void_platform_installation AS original
      ON original.singleton = true
      AND original.installation_id = installation.installation_id
    WHERE installation.id = 1
      AND installation.installation_id = ${input.installationId}
      AND installation.operator_id = ${input.operatorId}
      AND original.ownership_nonce = ${input.ownershipNonce}
  `);
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  verifyClaimManifest(row, input.installationId);
  return row;
}

/** Resolves only the current C1 seed through the original authentication seam. */
export function createCasimirBootstrapOptions(
  input: Pick<
    CasimirManagementConfig,
    'installationId' | 'ownershipNonce' | 'operatorId' | 'projectId'
  >,
): BootstrapOptions {
  return {
    beforeAuthAdmission: (transaction, requestedInstallationId) =>
      lockCasimirManagementAdmission(transaction, requestedInstallationId, input),
    validateInstallationOwnership: async (transaction: Db, requestedInstallationId: string) =>
      Boolean(await readCasimirOwnership(transaction, requestedInstallationId, input)),
    existingAdministrator: async (transaction: Db, requestedInstallationId: string) => {
      const ownership = await readCasimirOwnership(transaction, requestedInstallationId, input);
      if (!ownership || ownership.phase !== 'ready') return null;

      const result = await transaction.execute<CasimirSeedRow>(sql`
        SELECT seeded.role, seeded.suspended_reason
        FROM public.users AS seeded
        JOIN public.projects AS reference_project
          ON reference_project.id = ${ownership.project_id}
          AND reference_project.user_id = seeded.id
        WHERE seeded.id = ${input.operatorId}
          AND seeded.provider = 'casimir-local'
          AND seeded.provider_id = ${input.installationId}
        FOR UPDATE OF seeded, reference_project
      `);
      if (result.rows.length !== 1) return null;

      const row = result.rows[0]!;
      if (row.role !== 'admin' || isAdminSuspended(row.suspended_reason)) return null;
      return input.operatorId;
    },
  };
}
