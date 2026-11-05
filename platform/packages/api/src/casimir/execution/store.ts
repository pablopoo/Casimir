import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.ts';
import { generateId } from '../../id.ts';
import { requireProjectCapability } from '../../project-access.ts';
import { requireNormalizedProject } from '../../project-state.ts';
import { isAdminSuspended } from '../../suspension.ts';
import { LocalHttpError } from '../project-service.ts';
import { digest } from './profile.ts';
import type { ExecutionProfile, ImageAlias, Operation } from './types.ts';

export async function assertExecutionMigrations(db: DbOrTx): Promise<void> {
  const hash = digest(readFileSync('casimir/execution-migrations/0001_execution.sql', 'utf8'));
  const result = await db.execute<{ version: number; hash: string }>(
    sql`SELECT version,hash FROM casimir.schema_migrations`,
  );
  if (result.rows.length !== 1 || result.rows[0].version !== 1 || result.rows[0].hash !== hash)
    throw new Error('execution migration mismatch');
}
async function actorLive(db: DbOrTx, actorId: string) {
  const actor = await db.execute<{ suspended_reason: string | null }>(
    sql`SELECT suspended_reason FROM users WHERE id=${actorId} FOR SHARE`,
  );
  if (!actor.rows[0]) throw new LocalHttpError(401, 'operator unavailable');
  if (isAdminSuspended(actor.rows[0].suspended_reason))
    throw new LocalHttpError(403, 'account suspended');
}
export async function admitExecution(
  db: Db,
  actorId: string,
  projectId: string,
  deploymentId: string,
  key: string,
  alias: string,
  profile: ExecutionProfile,
): Promise<Operation> {
  if (!/^[\x20-\x7e]{1,128}$/.test(key) || !Object.hasOwn(profile.images, alias))
    throw new LocalHttpError(400, 'invalid execution request');
  const imageId = profile.images[alias as ImageAlias];
  const hash = digest(
    JSON.stringify({ deploymentId, alias, imageId, profile: profile.fingerprint }),
  );
  return db.transaction(async (tx) => {
    const scope = await tx.execute<{ project_id: string | null }>(
      sql`SELECT project_id FROM casimir.execution_scope WHERE id=1 FOR UPDATE`,
    );
    await tx.execute(sql`SELECT id FROM projects WHERE id=${projectId} FOR UPDATE`);
    await actorLive(tx, actorId);
    const access = await requireProjectCapability(tx, projectId, actorId, 'deploy');
    if (access.project.status === 'deleting')
      throw new LocalHttpError(410, 'project is being deleted');
    await requireNormalizedProject(tx, access.project);
    const prior = await tx.execute<Operation>(
      sql`SELECT * FROM casimir.execution_operations WHERE project_id=${projectId} AND actor_id=${actorId} AND idempotency_key=${key} FOR UPDATE`,
    );
    if (prior.rows[0]) {
      if (prior.rows[0].input_hash !== hash)
        throw new LocalHttpError(409, 'idempotency input conflict');
      return prior.rows[0];
    }
    const deployment = await tx.execute<{ status: string; source: string }>(
      sql`SELECT status,source FROM deployments WHERE id=${deploymentId} AND project_id=${projectId} FOR UPDATE`,
    );
    if (!deployment.rows[0]) throw new LocalHttpError(404, 'deployment not found');
    if (deployment.rows[0].status !== 'pending' || deployment.rows[0].source !== 'casimir-record')
      throw new LocalHttpError(409, 'deployment is not eligible');
    if (!scope.rows[0]) throw new Error('execution scope unavailable');
    if (scope.rows[0].project_id && scope.rows[0].project_id !== projectId)
      throw new LocalHttpError(409, 'execution scope already bound');
    const busy = await tx.execute(
      sql`SELECT id FROM casimir.execution_operations WHERE deployment_id=${deploymentId} OR (project_id=${projectId} AND phase NOT IN ('succeeded','failed')) LIMIT 1`,
    );
    if (busy.rows.length) throw new LocalHttpError(409, 'execution already associated or blocked');
    await tx.execute(sql`UPDATE casimir.execution_scope SET project_id=${projectId} WHERE id=1`);
    const result = await tx.execute<Operation>(sql`INSERT INTO casimir.execution_operations
      (id,project_id,deployment_id,actor_id,idempotency_key,input_hash,image_alias,image_id,profile_hash)
      VALUES (${generateId('cex')},${projectId},${deploymentId},${actorId},${key},${hash},${alias},${imageId},${profile.fingerprint}) RETURNING *`);
    return result.rows[0];
  });
}
export async function readOperation(
  db: Db,
  actorId: string,
  projectId: string,
  operationId: string,
): Promise<Operation | null> {
  await requireProjectCapability(db, projectId, actorId, 'read');
  const result = await db.execute<Operation>(
    sql`SELECT * FROM casimir.execution_operations WHERE id=${operationId} AND project_id=${projectId}`,
  );
  return result.rows[0] ?? null;
}
export async function receipt(db: DbOrTx, op: Operation) {
  const state = await db.execute<{ active_deployment_id: string | null }>(
    sql`SELECT active_deployment_id FROM projects WHERE id=${op.project_id}`,
  );
  return {
    operationId: op.id,
    phase: op.phase,
    requestedTarget: {
      deploymentId: op.deployment_id,
      imageId: op.image_id,
      imageAlias: op.image_alias,
    },
    activeDeploymentId: state.rows[0]?.active_deployment_id ?? null,
    lastObservedTarget: op.last_observation?.target ?? null,
    observedAt: op.last_observation?.observedAt ?? null,
    outcome: op.outcome,
    error: op.error,
  };
}

import {
  beginDeploymentCutover,
  updateDeploymentStatus,
  setActiveDeployment,
  markDeploymentRetained,
} from '../../db/deployments.ts';
import type { Target, RouteIdentity, Observation, Phase, Outcome } from './types.ts';
export async function operationById(db: DbOrTx, id: string): Promise<Operation> {
  const r = await db.execute<Operation>(
    sql`SELECT * FROM casimir.execution_operations WHERE id=${id}`,
  );
  if (!r.rows[0]) throw new Error('operation missing');
  return r.rows[0];
}
export async function pendingOperations(db: Db) {
  return (
    await db.execute<Operation>(
      sql`SELECT * FROM casimir.execution_operations WHERE phase NOT IN ('succeeded','failed') ORDER BY created_at`,
    )
  ).rows;
}
async function locked<T>(
  db: Db,
  id: string,
  fn: (tx: DbOrTx, op: Operation) => Promise<T>,
): Promise<T> {
  const hint = await operationById(db, id);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM casimir.execution_scope WHERE id=1 FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM projects WHERE id=${hint.project_id} FOR UPDATE`);
    const r = await tx.execute<Operation>(
      sql`SELECT * FROM casimir.execution_operations WHERE id=${id} FOR UPDATE`,
    );
    await tx.execute(sql`SELECT id FROM deployments WHERE id=${hint.deployment_id} FOR UPDATE`);
    return fn(tx, r.rows[0]);
  });
}
async function authority(tx: DbOrTx, op: Operation) {
  await actorLive(tx, op.actor_id);
  const access = await requireProjectCapability(tx, op.project_id, op.actor_id, 'deploy');
  if (access.project.status === 'deleting') throw new Error('project deleting');
  await requireNormalizedProject(tx, access.project);
  return access;
}
function owned(op: Operation, instance: string, phases: Phase[]) {
  if (op.executor_instance !== instance || !phases.includes(op.phase))
    throw new Error('operation state conflict');
}
async function pointer(tx: DbOrTx, op: Operation) {
  const r = await tx.execute<{ active_deployment_id: string | null }>(
    sql`SELECT active_deployment_id FROM projects WHERE id=${op.project_id}`,
  );
  if (r.rows[0].active_deployment_id !== (op.previous_target?.deploymentId ?? null))
    throw new Error('active pointer conflict');
}
export async function claimQueued(db: Db, id: string, instance: string, route: RouteIdentity) {
  return locked(db, id, async (tx, op) => {
    if (op.phase !== 'queued') throw new Error('operation state conflict');
    const access = await authority(tx, op);
    if (
      access.project.active_deployment_id !== (route.target?.deploymentId ?? null) ||
      (route.target && route.target.projectId !== op.project_id)
    )
      throw new Error('active route conflict');
    const d = await tx.execute<{ status: string; source: string }>(
      sql`SELECT status,source FROM deployments WHERE id=${op.deployment_id} AND project_id=${op.project_id}`,
    );
    if (d.rows[0]?.status !== 'pending' || d.rows[0]?.source !== 'casimir-record')
      throw new Error('deployment state conflict');
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase='preflighting',executor_instance=${instance},previous_target=${JSON.stringify(route.target)}::jsonb,route_identity=${JSON.stringify(route)}::jsonb,updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function beginCutover(db: Db, id: string, instance: string) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, ['preflighting']);
    await authority(tx, op);
    await pointer(tx, op);
    if (!(await beginDeploymentCutover(tx, op.deployment_id)))
      throw new Error('deployment cutover conflict');
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase='cutover',updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function setPhase(
  db: Db,
  id: string,
  instance: string,
  from: Phase[],
  phase: Phase,
  candidateId?: string,
) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, from);
    if (phase === 'compensating') await pointer(tx, op);
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase=${phase},candidate_id=COALESCE(${candidateId ?? null},candidate_id),updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function recordObservation(
  db: Db,
  id: string,
  instance: string,
  observation: Observation,
) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, ['preflighting', 'cutover', 'verifying', 'compensating']);
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET last_observation=${JSON.stringify(observation)}::jsonb,route_identity=${JSON.stringify(observation.route)}::jsonb,updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function finalizeSuccess(db: Db, id: string, instance: string) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, ['verifying']);
    await authority(tx, op);
    await pointer(tx, op);
    const observation = op.last_observation;
    if (
      !observation?.healthy ||
      !observation.writable ||
      !observation.loopbackVerified ||
      observation.target?.deploymentId !== op.deployment_id ||
      observation.target.containerId !== op.candidate_id ||
      observation.target.imageId !== op.image_id ||
      observation.route.target?.containerId !== op.candidate_id
    )
      throw new Error('unverified target');
    const d = await tx.execute<{ status: string; project_id: string }>(
      sql`SELECT status,project_id FROM deployments WHERE id=${op.deployment_id}`,
    );
    if (d.rows[0]?.status !== 'cutover' || d.rows[0].project_id !== op.project_id)
      throw new Error('deployment state conflict');
    await setActiveDeployment(tx, op.project_id, op.deployment_id);
    await updateDeploymentStatus(tx, op.deployment_id, 'live');
    if (op.previous_target) await markDeploymentRetained(tx, op.previous_target.deploymentId, true);
    const readback = await tx.execute<{ active_deployment_id: string | null; status: string }>(
      sql`SELECT p.active_deployment_id,d.status FROM projects p JOIN deployments d ON d.id=${op.deployment_id} WHERE p.id=${op.project_id}`,
    );
    if (
      readback.rows[0]?.active_deployment_id !== op.deployment_id ||
      readback.rows[0]?.status !== 'live'
    )
      throw new Error('activation readback failed');
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase='succeeded',outcome='activated',error=NULL,updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function finalizeFailure(
  db: Db,
  id: string,
  instance: string,
  outcome: Exclude<Outcome, 'activated'>,
  error: string,
) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, ['preflighting', 'cutover', 'verifying', 'compensating']);
    await pointer(tx, op);
    await updateDeploymentStatus(tx, op.deployment_id, 'failed');
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase='failed',outcome=${outcome},error=${error},updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function blockOperation(db: Db, id: string, error: string) {
  return locked(db, id, async (tx, op) => {
    if (['succeeded', 'failed'].includes(op.phase)) return op;
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET phase='recovery_required',outcome=NULL,error=${error},updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function takeRecovery(db: Db, id: string, instance: string) {
  return locked(db, id, async (tx, op) => {
    if (['queued', 'succeeded', 'failed', 'recovery_required'].includes(op.phase))
      throw new Error('recovery state conflict');
    await pointer(tx, op);
    await tx.execute(
      sql`UPDATE casimir.execution_operations SET executor_instance=${instance},updated_at=now() WHERE id=${id}`,
    );
    return operationById(tx, id);
  });
}
export async function operationForDeployment(db: DbOrTx, deploymentId: string): Promise<Operation> {
  const r = await db.execute<Operation>(
    sql`SELECT * FROM casimir.execution_operations WHERE deployment_id=${deploymentId}`,
  );
  if (!r.rows[0]) throw new Error('previous operation missing');
  return r.rows[0];
}
export async function validatePreflight(db: Db, id: string, instance: string) {
  return locked(db, id, async (tx, op) => {
    owned(op, instance, ['preflighting']);
    await authority(tx, op);
    await pointer(tx, op);
    const d = await tx.execute<{ status: string; source: string }>(
      sql`SELECT status,source FROM deployments WHERE id=${op.deployment_id} AND project_id=${op.project_id}`,
    );
    if (d.rows[0]?.status !== 'pending' || d.rows[0]?.source !== 'casimir-record')
      throw new Error('deployment state conflict');
  });
}
