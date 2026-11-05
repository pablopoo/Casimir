import { digest } from './profile.ts';
import { routeConfig } from './routing.ts';
import type { RunnerContext } from './runner.ts';
import { executeOperation, compensate } from './runner.ts';
import * as store from './store.ts';
import type { Operation, Target } from './types.ts';
export async function reconcileOperation(ctx: RunnerContext, id: string): Promise<Operation> {
  let op = await store.operationById(ctx.db, id);
  if (['succeeded', 'failed', 'recovery_required'].includes(op.phase)) return op;
  if (op.phase === 'queued') return executeOperation(ctx, id);
  try {
    ctx.guard.assertLive();
    if (
      op.profile_hash !== ctx.profile.fingerprint ||
      ctx.profile.images[op.image_alias] !== op.image_id
    )
      throw new Error('profile drift');
    op = await store.takeRecovery(ctx.db, id, ctx.guard.instance);
    const route = await ctx.routes.read();
    const c = await ctx.engine.inspectContainer(ctx.engine.candidateName(op));
    if (c) ctx.engine.validateCandidate(op, c);
    if (op.phase === 'verifying' && c && op.candidate_id !== c.Id)
      throw new Error('candidate identity conflict');
    const candidateId = c?.Id ?? op.candidate_id;
    const candidate: Target | null = candidateId
      ? {
          projectId: op.project_id,
          deploymentId: op.deployment_id,
          containerId: candidateId,
          imageId: op.image_id,
          version: op.image_alias.slice(5),
        }
      : null;
    const previousHash = digest(routeConfig(op.previous_target));
    const candidateHash = candidate ? digest(routeConfig(candidate)) : null;
    if (route.fingerprint !== previousHash && route.fingerprint !== candidateHash)
      throw new Error('unexpected route');
    if (op.phase === 'preflighting') {
      if (route.fingerprint !== previousHash) throw new Error('unexpected route');
      return executeOperation(ctx, id);
    }
    if (op.phase === 'verifying' && candidate && route.fingerprint === candidateHash) {
      if (op.candidate_id !== candidate.containerId) throw new Error('candidate identity conflict');
      if (op.previous_target) {
        const old = await ctx.engine.validateRecordedTarget(op.previous_target);
        if (old.State.Running) throw new Error('previous writer still running');
      }
      try {
        const observed = await ctx.engine.observeCandidate(op);
        if (!observed.writable) throw new Error('candidate not writable');
        const observation = await ctx.engine.runLoopbackProbe(observed.target, route, op);
        await store.recordObservation(ctx.db, id, ctx.guard.instance, observation);
        return await store.finalizeSuccess(ctx.db, id, ctx.guard.instance);
      } catch {
        ctx.guard.assertLive();
        return await compensate(ctx, op);
      }
    }
    return await compensate(ctx, op);
  } catch {
    ctx.guard.assertLive();
    return store.blockOperation(ctx.db, id, 'startup evidence requires operator recovery');
  }
}
export async function reconcileStartup(ctx: RunnerContext) {
  await ctx.engine.reconcileJobs((id) => store.operationById(ctx.db, id));
  for (const op of await store.pendingOperations(ctx.db)) {
    if (op.phase !== 'queued' && op.phase !== 'recovery_required')
      await reconcileOperation(ctx, op.id);
  }
}
