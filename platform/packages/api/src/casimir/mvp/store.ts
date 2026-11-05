import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertCasimirRuntime,
  parseCasimirManifest,
  parseRuntimeDescriptor,
  type RuntimeDescriptor,
} from '@void/deploy-core';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.ts';
import { createDeployment } from '../../db/deployments.ts';
import { generateId } from '../../id.ts';
import { requireProjectCapability } from '../../project-access.ts';
import { requireNormalizedProject } from '../../project-state.ts';
import { isAdminSuspended } from '../../suspension.ts';
import { LocalHttpError } from '../project-service.ts';
import { assertInstallationAdmission } from '../lifecycle/maintenance.ts';
import {assertRetentionInventoryBudget} from '../lifecycle/retention-inventory.ts';
import {
  MVP_PHASES,
  type MvpOperation,
  type MvpArtifact,
  type Receipt,
  type OperationView,
} from './types.ts';
export async function assertMvpMigrations(db: DbOrTx): Promise<void> {
  const hash = createHash('sha256')
    .update(readFileSync('casimir/mvp-a/migrations/0001_admission.sql'))
    .digest('hex');
  const result = await db.execute<{ version: number; hash: string }>(
    sql`SELECT version,hash FROM casimir_mvp_a.schema_migrations ORDER BY version`,
  );
  if (result.rows.length !== 1 || result.rows[0].version !== 1 || result.rows[0].hash !== hash) {
    throw new Error('MVP migration mismatch');
  }
}
export async function lockMvpProject(
  tx: DbOrTx,
  actorId: string,
  projectId: string,
  capability: 'read' | 'deploy' = 'deploy',
) {
  const scope = await tx.execute<{ project_id: string | null }>(
    sql`SELECT project_id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`,
  );
  await tx.execute(sql`SELECT id FROM projects WHERE id=${projectId} FOR UPDATE`);
  const actors = await tx.execute<{ suspended_reason: string | null }>(
    sql`SELECT suspended_reason FROM users WHERE id=${actorId} FOR SHARE`,
  );
  if (!actors.rows[0]) {
    throw new LocalHttpError(401, 'operator unavailable');
  }
  if (isAdminSuspended(actors.rows[0].suspended_reason)) {
    throw new LocalHttpError(403, 'account suspended');
  }
  const access = await requireProjectCapability(tx, projectId, actorId, capability);
  if (access.project.status === 'deleting') {
    throw new LocalHttpError(410, 'project is being deleted');
  }
  await requireNormalizedProject(tx, access.project);
  if (!scope.rows[0]) {
    throw new Error('MVP scope unavailable');
  }
  if (scope.rows[0].project_id && scope.rows[0].project_id !== projectId) {
    throw new LocalHttpError(409, 'MVP scope already bound');
  }
  await tx.execute(sql`UPDATE casimir_mvp_a.scope SET project_id=${projectId} WHERE id=1`);
  return access;
}
export function mapMvpOperation(row: unknown): MvpOperation {
  if (!row || typeof row !== 'object') {
    throw new Error('operation row');
  }
  const v = row as Record<string, unknown>;
  for (const key of [
    'id',
    'project_id',
    'actor_id',
    'artifact_id',
    'deployment_id',
    'idempotency_key',
    'input_hash',
  ]) {
    if (typeof v[key] !== 'string') {
      throw new Error('operation row');
    }
  }
  if (
    !MVP_PHASES.includes(v.phase as never) ||
    (v.outcome !== null && typeof v.outcome !== 'string')
  ) {
    throw new Error('operation phase');
  }
  for (const key of [
    'image_id',
    'secret_revision',
    'migration_fingerprint',
    'snapshot_fingerprint',
    'candidate_id',
    'job_id',
    'error',
  ]) {
    if (v[key] !== null && typeof v[key] !== 'string') {
      throw new Error('operation row');
    }
  }
  parseRuntimeDescriptor(v.runtime);
  for (const key of ['previous_target', 'compatibility_proof', 'observation']) {
    if (v[key] !== null && (typeof v[key] !== 'object' || Array.isArray(v[key]))) {
      throw new Error('operation JSON');
    }
  }
  const dates: Record<string, Date | null> = {};
  for (const key of ['created_at', 'updated_at', 'exposure_started']) {
    if (key === 'exposure_started' && v[key] === null) {
      dates[key] = null;
      continue;
    }
    if (!(v[key] instanceof Date) && typeof v[key] !== 'string') {
      throw new Error('operation date');
    }
    const date = new Date(v[key] as Date | string);
    if (!Number.isFinite(date.getTime())) {
      throw new Error('operation date');
    }
    dates[key] = date;
  }
  return { ...v, ...dates } as unknown as MvpOperation;
}
function publicObservation(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (
    !value ||
    typeof value.deploymentId !== 'string' ||
    !/^dpl_[a-z0-9]{12}$/.test(value.deploymentId) ||
    typeof value.artifactId !== 'string' ||
    !/^car_[a-z0-9]{12}$/.test(value.artifactId) ||
    typeof value.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    return null;
  }
  return {
    deploymentId: value.deploymentId,
    artifactId: value.artifactId,
    imageId: value.imageId,
    observedAt: new Date(value.observedAt).toISOString(),
  };
}
const publicErrors = new Set([
  'operation_failed',
  'artifact_invalid',
  'prepare_failed',
  'migration_failed',
  'candidate_failed',
  'compatibility_failed',
  'recovery_required',
  'authority_revoked',
  'interrupted',
]);
export async function admitArtifactDeployment(
  db: Db,
  actorId: string,
  projectId: string,
  artifactId: string,
  key: string,
  expectedRuntime: RuntimeDescriptor,
  installationId?: string,
): Promise<Receipt> {
  if (!/^[\x20-\x7e]{1,128}$/.test(key)) {
    throw new LocalHttpError(400, 'invalid idempotency key');
  }
  return db.transaction(async (tx) => {
    if (installationId) await assertInstallationAdmission(tx, installationId);
    const access = await lockMvpProject(tx, actorId, projectId);
    const hash = createHash('sha256').update(JSON.stringify({ artifactId })).digest('hex');
    const prior = await tx.execute<MvpOperation>(
      sql`SELECT * FROM casimir_mvp_a.operations WHERE project_id=${projectId} AND actor_id=${actorId} AND idempotency_key=${key} FOR UPDATE`,
    );
    if (prior.rows[0]) {
      const op = mapMvpOperation(prior.rows[0]);
      if (op.input_hash !== hash) {
        throw new LocalHttpError(409, 'idempotency input conflict');
      }
      return { operationId: op.id, deploymentId: op.deployment_id };
    }
    const artifacts = await tx.execute<MvpArtifact>(
      sql`SELECT * FROM casimir_mvp_a.artifacts WHERE id=${artifactId} AND project_id=${projectId} AND actor_id=${actorId} FOR SHARE`,
    );
    const artifact = artifacts.rows[0];
    if (!artifact) {
      throw new LocalHttpError(409, 'artifact is not finalized for this owner');
    }
    try {
      assertCasimirRuntime(parseCasimirManifest(artifact.manifest), expectedRuntime);
      assertCasimirRuntime(artifact.runtime, expectedRuntime);
    } catch {
      throw new LocalHttpError(409, 'artifact runtime is no longer current');
    }
    const busy = await tx.execute(
      sql`SELECT id FROM casimir_mvp_a.operations WHERE project_id=${projectId} AND phase NOT IN ('succeeded','failed') LIMIT 1`,
    );
    if (busy.rows.length) {
      throw new LocalHttpError(409, 'MVP operation already active');
    }
    if (installationId) await assertRetentionInventoryBudget(tx, installationId, { additionalOperations: 1 });
    const deployment = await createDeployment(
      tx,
      projectId,
      JSON.stringify(artifact.manifest),
      'casimir-artifact',
      null,
      { billingUserId: access.owner.id, initiatedByUserId: actorId },
    );
    const id = generateId('cmv');
    await tx.execute(
      sql`INSERT INTO casimir_mvp_a.operations(id,project_id,actor_id,artifact_id,deployment_id,idempotency_key,input_hash,runtime) VALUES(${id},${projectId},${actorId},${artifactId},${deployment.id},${key},${hash},${JSON.stringify(artifact.runtime)}::jsonb)`,
    );
    return { operationId: id, deploymentId: deployment.id };
  });
}
export async function readMvpOperation(
  db: Db,
  actorId: string,
  projectId: string,
  id: string,
): Promise<OperationView> {
  await requireProjectCapability(db, projectId, actorId, 'read');
  const result = await db.execute<MvpOperation>(
    sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${id} AND project_id=${projectId}`,
  );
  if (!result.rows[0]) {
    throw new LocalHttpError(404, 'operation not found');
  }
  const op = mapMvpOperation(result.rows[0]);
  return {
    operationId: op.id,
    phase: op.phase,
    outcome: op.outcome,
    desired: { deploymentId: op.deployment_id, artifactId: op.artifact_id, imageId: op.image_id },
    verifiedServing: publicObservation(op.observation),
    error: op.error === null ? null : publicErrors.has(op.error) ? op.error : 'operation_failed',
  };
}
