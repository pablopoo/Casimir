import { randomBytes } from 'node:crypto';
import {
  assertCasimirRuntime,
  canonicalJson,
  parseCasimirManifest,
  type MigrationPlan,
  type CasimirManifest,
} from '@void/deploy-core';
import { sql } from 'drizzle-orm';
import {
  updateDeploymentStatus,
  markDeploymentRetained,
  setActiveDeployment,
} from '../../db/deployments.ts';
import type { MvpEngine } from './engine.ts';
import { isMvpDigest, parseMvpPlanResult } from './job-results.ts';
import { prepareArtifactImage, type MvpPreparationContext } from './prepare.ts';
import type { MvpRouteStore, MvpTarget } from './routing.ts';
import { lockMvpProject, mapMvpOperation } from './store.ts';
import type { MvpOperation, MvpPhase } from './types.ts';

export type MvpContext = MvpPreparationContext & {
  engine: MvpEngine;
  routes: MvpRouteStore;
  operationId?: string;
  failpoint?: (name: string) => Promise<void>;
};
type SnapshotRef = { path: string; sha256: string; schemaDigest: string };
type Job = { id: string; action: string; parameters: Record<string, unknown>; releaseId: string };
type Journal = {
  route: MvpTarget | null;
  previousOperationId: string | null;
  jobs: Record<string, Job>;
  plan?: MigrationPlan;
  preflight?: SnapshotRef;
  quiesced?: SnapshotRef;
  result?: { schemaDigest: string };
  compensationExposure?: boolean;
};
export type RetainedRelease = {
  operation: MvpOperation;
  sha256: string;
  manifest: CasimirManifest;
};
export type CompatibilityProof = {
  artifactHash: string;
  hookHash: string;
  runtimeId: string;
  schemaDigest: string;
  snapshotHash: string;
  passed: true;
};
const nonce = () => randomBytes(16).toString('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function journal(op: MvpOperation): Journal {
  const value = op.previous_target as Journal | null;
  if (!value || !Object.hasOwn(value, 'route') || !value.jobs || typeof value.jobs !== 'object') {
    throw new Error('journal_invalid');
  }
  return structuredClone(value);
}
export async function mvpOperationById(ctx: MvpContext, id: string): Promise<MvpOperation> {
  const result = await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${id}`);
  return mapMvpOperation(result.rows[0]);
}
async function change(
  ctx: MvpContext,
  id: string,
  phase: MvpPhase,
  patch: Partial<MvpOperation> = {},
  authority = true,
): Promise<MvpOperation> {
  ctx.guard.assertLive();
  const before = await mvpOperationById(ctx, id);
  return ctx.db.transaction(async (tx) => {
    if (authority) {
      await lockMvpProject(tx, before.actor_id, before.project_id);
    } else {
      await tx.execute(sql`SELECT id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM projects WHERE id=${before.project_id} FOR UPDATE`);
    }
    const rows = await tx.execute(
      sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${id} FOR UPDATE`,
    );
    const current = mapMvpOperation(rows.rows[0]);
    if (current.phase !== before.phase || !same(current.previous_target, before.previous_target)) {
      throw new Error('journal_conflict');
    }
    if (['succeeded', 'failed'].includes(current.phase)) {
      throw new Error('operation_terminal');
    }
    const next = { ...current, ...patch, phase };
    ctx.guard.assertLive();
    await tx.execute(
      sql`UPDATE casimir_mvp_a.operations SET phase=${phase},previous_target=${JSON.stringify(next.previous_target)}::jsonb,image_id=${next.image_id},candidate_id=${next.candidate_id},job_id=${next.job_id},secret_revision=${next.secret_revision},migration_fingerprint=${next.migration_fingerprint},snapshot_fingerprint=${next.snapshot_fingerprint},compatibility_proof=${JSON.stringify(next.compatibility_proof)}::jsonb,exposure_started=${next.exposure_started?.toISOString() ?? null},observation=${JSON.stringify(next.observation)}::jsonb,error=${next.error},outcome=${next.outcome},updated_at=now() WHERE id=${id}`,
    );
    if (phase === 'maintenance') {
      await updateDeploymentStatus(tx, current.deployment_id, 'cutover');
    }
    if (phase === 'failed') {
      await updateDeploymentStatus(tx, current.deployment_id, 'failed');
    }
    const result = await tx.execute(sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${id}`);
    return mapMvpOperation(result.rows[0]);
  });
}
async function job(
  ctx: MvpContext,
  id: string,
  key: string,
  action: string,
  parameters: Record<string, unknown>,
  release?: MvpOperation,
): Promise<Record<string, unknown>> {
  let op = await mvpOperationById(ctx, id);
  const meta = journal(op);
  let record = meta.jobs[key];
  if (record) {
    if (
      record.action !== action ||
      !same(record.parameters, parameters) ||
      record.releaseId !== (release ?? op).id
    ) {
      throw new Error('job_conflict');
    }
  } else {
    record = { id: nonce(), action, parameters, releaseId: (release ?? op).id };
    meta.jobs[key] = record;
    op = await change(
      ctx,
      id,
      op.phase,
      { previous_target: meta, job_id: record.id },
      op.phase !== 'compensating',
    );
  }
  return ctx.engine.runJob(op, action, record.id, parameters, release);
}
async function retained(ctx: MvpContext, op: MvpOperation): Promise<RetainedRelease | null> {
  const meta = journal(op);
  if (!meta.previousOperationId) {
    return null;
  }
  const previous = await mvpOperationById(ctx, meta.previousOperationId);
  if (
    previous.phase !== 'succeeded' ||
    previous.deployment_id !== meta.route?.deploymentId ||
    previous.image_id !== meta.route.imageId ||
    previous.candidate_id !== meta.route.containerId
  ) {
    throw new Error('previous_identity');
  }
  const rows = await ctx.db.execute<{ sha256: string; manifest: CasimirManifest }>(
    sql`SELECT sha256,manifest FROM casimir_mvp_a.artifacts WHERE id=${previous.artifact_id}`,
  );
  if (!rows.rows[0]) {
    throw new Error('previous_artifact');
  }
  assertCasimirRuntime(parseCasimirManifest(rows.rows[0].manifest), previous.runtime);
  return { operation: previous, ...rows.rows[0] };
}
export async function verifyRetainedCompatibility(
  ctx: MvpContext,
  release: RetainedRelease,
  snapshot: SnapshotRef,
): Promise<CompatibilityProof> {
  if (
    !ctx.operationId ||
    !snapshot.path.startsWith('/snapshots/') ||
    !/^([a-f0-9]{64})$/.test(snapshot.sha256) ||
    !/^([a-f0-9]{64})$/.test(snapshot.schemaDigest)
  ) {
    throw new Error('compatibility_snapshot');
  }
  const path = release.manifest.compatibilityEntry;
  const hook = release.manifest.files.find((f) => f.path === path);
  if (!path || !hook) {
    throw new Error('compatibility_missing');
  }
  const result = await job(
    ctx,
    ctx.operationId,
    'compatibility',
    'compatibility',
    {
      path: snapshot.path,
      expectedSha256: snapshot.sha256,
      expectedSchemaDigest: snapshot.schemaDigest,
    },
    release.operation,
  );
  if (result.ok !== true) {
    throw new Error('compatibility_failed');
  }
  return {
    artifactHash: release.sha256,
    hookHash: hook.sha256,
    runtimeId: release.operation.runtime.runtimeId,
    schemaDigest: snapshot.schemaDigest,
    snapshotHash: snapshot.sha256,
    passed: true,
  };
}
async function gate(
  ctx: MvpContext,
  target: MvpTarget | null,
  allowed: Array<MvpTarget | null>,
): Promise<void> {
  ctx.guard.assertLive();
  const current = await ctx.routes.read();
  if (!allowed.some((value) => same(value, current.target))) {
    throw new Error('route_conflict');
  }
  if (!same(current.target, target)) {
    await ctx.routes.replace(current, target);
  }
  await ctx.engine.reloadProxy();
}
function target(op: MvpOperation): MvpTarget {
  if (!op.image_id || !op.candidate_id) {
    throw new Error('candidate_identity');
  }
  return {
    projectId: op.project_id,
    deploymentId: op.deployment_id,
    artifactId: op.artifact_id,
    containerId: op.candidate_id,
    imageId: op.image_id,
  };
}
async function finalize(ctx: MvpContext, op: MvpOperation): Promise<MvpOperation> {
  ctx.guard.assertLive();
  await ctx.engine.assertSingleWriter(op);
  await ctx.engine.privateProbe(op, op.candidate_id!);
  await ctx.engine.observeIngress(op);
  const route = await ctx.routes.read();
  if (!same(route.target, target(op))) {
    throw new Error('route_conflict');
  }
  return ctx.db.transaction(async (tx) => {
    await lockMvpProject(tx, op.actor_id, op.project_id);
    const project = await tx.execute<{ active_deployment_id: string | null }>(
      sql`SELECT active_deployment_id FROM projects WHERE id=${op.project_id}`,
    );
    if (project.rows[0]?.active_deployment_id !== (journal(op).route?.deploymentId ?? null)) {
      throw new Error('pointer_conflict');
    }
    const current = await tx.execute(
      sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${op.id} FOR UPDATE`,
    );
    if (mapMvpOperation(current.rows[0]).phase !== 'exposure_started') {
      throw new Error('phase_conflict');
    }
    ctx.guard.assertLive();
    await setActiveDeployment(tx, op.project_id, op.deployment_id);
    await updateDeploymentStatus(tx, op.deployment_id, 'live');
    if (journal(op).route) {
      await markDeploymentRetained(tx, journal(op).route!.deploymentId, true);
    }
    const observation = {
      deploymentId: op.deployment_id,
      artifactId: op.artifact_id,
      imageId: op.image_id,
      observedAt: new Date().toISOString(),
    };
    await tx.execute(
      sql`UPDATE casimir_mvp_a.operations SET phase='succeeded',outcome='activated',error=NULL,observation=${JSON.stringify(observation)}::jsonb,updated_at=now() WHERE id=${op.id}`,
    );
    const result = await tx.execute(sql`SELECT * FROM casimir_mvp_a.operations WHERE id=${op.id}`);
    return mapMvpOperation(result.rows[0]);
  });
}
async function compensate(ctx: MvpContext, id: string): Promise<MvpOperation> {
  let op = await mvpOperationById(ctx, id);
  let meta = journal(op);
  const previous = await retained(ctx, op);
  // Every previously opened gate, including compensation's gate, forbids restore.
  const exposed = !!op.exposure_started || !!meta.compensationExposure;
  await gate(ctx, null, [null, meta.route, op.candidate_id ? target(op) : null]);
  await ctx.engine.observeIngress(null);
  if (op.candidate_id) {
    await ctx.engine.stopApp(op, op.candidate_id);
  }
  if (previous) {
    await ctx.engine.stopApp(previous.operation, meta.route!.containerId);
  }
  await ctx.engine.assertSingleWriter(null);
  if (previous) {
    if (exposed) {
      const current = await job(ctx, id, 'compensation-state-' + ctx.guard.instance, 'state', {
        path: '/data/app.sqlite',
      });
      if (current.schemaDigest !== meta.result?.schemaDigest) {
        throw new Error('schema_mismatch');
      }
      if (meta.plan?.pending.length) {
        const proof = op.compatibility_proof as CompatibilityProof | null;
        const hook = previous.manifest.files.find(
          (file) => file.path === previous.manifest.compatibilityEntry,
        );
        if (
          !proof ||
          !hook ||
          proof.passed !== true ||
          proof.artifactHash !== previous.sha256 ||
          proof.hookHash !== hook.sha256 ||
          proof.runtimeId !== previous.operation.runtime.runtimeId ||
          proof.schemaDigest !== current.schemaDigest ||
          proof.snapshotHash !== meta.preflight?.sha256
        ) {
          throw new Error('compatibility_missing');
        }
      }
    }
    if (!exposed && meta.quiesced) {
      await job(ctx, id, 'restore', 'restore', {
        path: meta.quiesced.path,
        expectedSha256: meta.quiesced.sha256,
      });
    }
    await ctx.engine.startApp(previous.operation);
    await ctx.engine.privateProbe(previous.operation, meta.route!.containerId);
    await ctx.engine.assertSingleWriter(previous.operation);
    op = await mvpOperationById(ctx, id);
    meta = journal(op);
    meta.compensationExposure = true;
    op = await change(ctx, id, 'compensating', { previous_target: meta }, false);
    await gate(ctx, meta.route, [null, meta.route]);
    await ctx.engine.observeIngress(previous.operation);
    return change(
      ctx,
      id,
      'failed',
      { outcome: exposed ? 'code_restored_current_data' : 'restored', error: 'candidate_failed' },
      false,
    );
  }
  return change(ctx, id, 'failed', { outcome: 'rejected', error: 'candidate_failed' }, false);
}
/** Resume only durable phases. No automatic restore after any possible public write. */
export async function runMvpOperation(ctx: MvpContext, id: string): Promise<MvpOperation> {
  ctx.guard.assertLive();
  let op = await mvpOperationById(ctx, id);
  if (['succeeded', 'failed', 'recovery_required'].includes(op.phase)) {
    return op;
  }
  try {
    for (let steps = 0; steps < 12; steps++) {
      op = await mvpOperationById(ctx, id);
      ctx.guard.assertLive();
      if (op.phase === 'queued' || op.phase === 'preparing') {
        await prepareArtifactImage(ctx, op);
        op = await mvpOperationById(ctx, id);
        const route = await ctx.routes.read();
        const project = await ctx.db.execute<{ active_deployment_id: string | null }>(
          sql`SELECT active_deployment_id FROM projects WHERE id=${op.project_id}`,
        );
        if ((route.target?.deploymentId ?? null) !== project.rows[0]?.active_deployment_id) {
          throw new Error('pointer_conflict');
        }
        let previousId: string | null = null;
        if (route.target) {
          const rows = await ctx.db.execute<{ id: string }>(
            sql`SELECT id FROM casimir_mvp_a.operations WHERE deployment_id=${route.target.deploymentId} AND phase='succeeded'`,
          );
          previousId = rows.rows[0]?.id ?? null;
          if (!previousId) {
            throw new Error('previous_identity');
          }
        }
        const artifact = await ctx.db.execute<{ manifest: unknown }>(
          sql`SELECT manifest FROM casimir_mvp_a.artifacts WHERE id=${op.artifact_id}`,
        );
        const revision = await ctx.engine.prepareSecrets(
          op,
          parseCasimirManifest(artifact.rows[0]?.manifest).envKeys,
        );
        await change(ctx, id, 'preflighting', {
          secret_revision: revision,
          previous_target: { route: route.target, previousOperationId: previousId, jobs: {} },
        });
        continue;
      }
      if (op.phase === 'preflighting') {
        let meta = journal(op);
        op = await mvpOperationById(ctx, id);
        meta = journal(op);
        const snapshot = meta.preflight?.path ?? '/snapshots/' + nonce() + '.sqlite';
        // Persist snapshot identity before the backup side effect.
        if (!meta.preflight) {
          meta.preflight = { path: snapshot, sha256: '', schemaDigest: '' };
          op = await change(ctx, id, 'preflighting', { previous_target: meta });
        }
        await job(ctx, id, 'online-backup', 'backup', {
          path: '/data/app.sqlite',
          destination: snapshot,
        });
        const plan = parseMvpPlanResult(
          await job(ctx, id, 'preflight-plan', 'plan', {
            path: snapshot,
          }),
        );
        const result = await job(ctx, id, 'preflight-apply', 'apply', { path: snapshot, plan });
        if (!isMvpDigest(result.schemaDigest) || !isMvpDigest(result.sha256)) {
          throw new Error('snapshot_identity');
        }
        op = await mvpOperationById(ctx, id);
        meta = journal(op);
        meta.plan = plan;
        meta.result = { schemaDigest: result.schemaDigest };
        meta.preflight = {
          path: snapshot,
          sha256: result.sha256,
          schemaDigest: result.schemaDigest,
        };
        op = await change(ctx, id, 'preflighting', {
          previous_target: meta,
          migration_fingerprint: plan.fingerprint,
        });
        const previous = await retained(ctx, op);
        const proof =
          previous && plan.pending.length
            ? await verifyRetainedCompatibility(
                { ...ctx, operationId: id },
                previous,
                meta.preflight,
              )
            : null;
        await change(ctx, id, 'maintenance', { compatibility_proof: proof });
        continue;
      }
      if (op.phase === 'maintenance') {
        let meta = journal(op);
        const previous = await retained(ctx, op);
        await gate(ctx, null, [null, meta.route]);
        await ctx.engine.observeIngress(null);
        if (previous) {
          await ctx.engine.stopApp(previous.operation, meta.route!.containerId);
        }
        await ctx.engine.assertSingleWriter(null);
        await ctx.failpoint?.('after_old_stop');
        const snapshot = meta.quiesced?.path ?? '/snapshots/' + nonce() + '.sqlite';
        if (!meta.quiesced) {
          meta.quiesced = { path: snapshot, sha256: '', schemaDigest: '' };
          await change(ctx, id, 'maintenance', { previous_target: meta });
        }
        const result = await job(ctx, id, 'quiesced-backup', 'backup', {
          path: '/data/app.sqlite',
          destination: snapshot,
        });
        if (!isMvpDigest(result.sha256) || !isMvpDigest(result.schemaDigest)) {
          throw new Error('snapshot_identity');
        }
        op = await mvpOperationById(ctx, id);
        meta = journal(op);
        meta.quiesced = {
          path: snapshot,
          sha256: result.sha256,
          schemaDigest: result.schemaDigest,
        };
        await change(ctx, id, 'migrating', {
          previous_target: meta,
          snapshot_fingerprint: result.sha256,
        });
        continue;
      }
      if (op.phase === 'migrating') {
        const meta = journal(op);
        if (!meta.plan || !meta.quiesced?.sha256) {
          throw new Error('journal_invalid');
        }
        await ctx.engine.assertSingleWriter(null);
        await ctx.engine.observeIngress(null);
        const result = await job(ctx, id, 'live-apply', 'apply', {
          path: '/data/app.sqlite',
          plan: meta.plan,
        });
        await ctx.failpoint?.('after_sqlite_commit');
        if (result.schemaDigest !== meta.result?.schemaDigest) {
          throw new Error('schema_mismatch');
        }
        await change(ctx, id, 'verifying');
        continue;
      }
      if (op.phase === 'verifying') {
        const candidate = await ctx.engine.startApp(op);
        op = await change(ctx, id, 'verifying', { candidate_id: candidate });
        await ctx.engine.assertSingleWriter(op);
        await ctx.engine.privateProbe(op, candidate);
        await change(ctx, id, 'exposure_started', { exposure_started: new Date() });
        await ctx.failpoint?.('before_gate_open');
        continue;
      }
      if (op.phase === 'exposure_started') {
        await ctx.engine.assertSingleWriter(op);
        await ctx.engine.privateProbe(op, op.candidate_id!);
        await gate(ctx, target(op), [null, target(op)]);
        await ctx.engine.observeIngress(op);
        await ctx.failpoint?.('after_gate_open');
        return await finalize(ctx, op);
      }
      if (op.phase === 'compensating') {
        return await compensate(ctx, id);
      }
      return op;
    }
    throw new Error('phase_loop');
  } catch (error) {
    ctx.guard.assertLive();
    op = await mvpOperationById(ctx, id);
    const known = new Set([
      'resource_recipe',
      'resource_network',
      'resource_ownership',
      'job_failed',
      'job_timeout',
      'image_identity',
      'image_build_identity',
      'runner_identity',
      'compatibility_missing',
      'schema_mismatch',
      'snapshot_identity',
      'runtime_env',
      'runtime_secret_revision',
      'previous_identity',
      'pointer_conflict',
      'route_conflict',
      'writer_conflict',
      'writer_inventory',
    ]);
    const code =
      error instanceof Error && known.has(error.message) ? error.message : 'operation_failed';
    console.error('Casimir MVP phase failed', op.phase, code);
    if (op.phase === 'queued' || op.phase === 'preparing' || op.phase === 'preflighting') {
      return change(ctx, id, 'failed', { outcome: 'rejected', error: code }, false);
    }
    try {
      if (op.phase !== 'compensating') {
        await change(ctx, id, 'compensating', { error: 'candidate_failed' }, false);
      }
      return await compensate(ctx, id);
    } catch {
      ctx.guard.assertLive();
      return change(ctx, id, 'recovery_required', { error: 'recovery_required' }, false);
    }
  }
}
export const reconcileMvpOperation: typeof runMvpOperation = runMvpOperation;
