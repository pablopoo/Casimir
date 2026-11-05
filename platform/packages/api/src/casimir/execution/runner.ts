import type { Db } from '../../db/client.ts';
import type { FixedEngine } from './docker-engine.ts';
import type { ExecutorGuard } from './guard.ts';
import { digest } from './profile.ts';
import { RouteStore, routeConfig } from './routing.ts';
import * as store from './store.ts';
import type { Operation, ExecutionProfile, Target } from './types.ts';
export interface RunnerContext {
  db: Db;
  engine: FixedEngine;
  profile: ExecutionProfile;
  guard: ExecutorGuard;
  routes: RouteStore;
}
export async function observePrevious(ctx: RunnerContext, op: Operation) {
  if (op.previous_target) {
    const previous = await store.operationForDeployment(ctx.db, op.previous_target.deploymentId);
    const observed = await ctx.engine.observeCandidate(previous);
    if (observed.target.containerId !== op.previous_target.containerId || !observed.writable)
      throw new Error('previous identity mismatch');
  }
  const route = await ctx.routes.read();
  if (route.fingerprint !== digest(routeConfig(op.previous_target)))
    throw new Error('route conflict');
  return ctx.engine.runLoopbackProbe(op.previous_target, route, op);
}
async function cleanupCandidate(ctx: RunnerContext, op: Operation) {
  const c = await ctx.engine.inspectContainer(ctx.engine.candidateName(op));
  if (c) {
    ctx.engine.validateCandidate(op, c);
    await ctx.engine.stop(c.Id);
    await ctx.engine.removeOwned(c.Id);
  }
}
export async function compensate(ctx: RunnerContext, op: Operation) {
  ctx.guard.assertLive();
  op = await store.setPhase(
    ctx.db,
    op.id,
    ctx.guard.instance,
    ['cutover', 'verifying', 'compensating'],
    'compensating',
  );
  const current = await ctx.routes.read();
  const previousHash = digest(routeConfig(op.previous_target));
  const candidate = await ctx.engine.inspectContainer(ctx.engine.candidateName(op));
  if (candidate) ctx.engine.validateCandidate(op, candidate);
  const candidateId = candidate?.Id ?? op.candidate_id;
  const candidateTarget: Target | null = candidateId
    ? {
        projectId: op.project_id,
        deploymentId: op.deployment_id,
        containerId: candidateId,
        imageId: op.image_id,
        version: op.image_alias.slice(5),
      }
    : null;
  if (
    current.fingerprint !== previousHash &&
    (!candidateTarget || current.fingerprint !== digest(routeConfig(candidateTarget)))
  )
    throw new Error('route conflict');
  await cleanupCandidate(ctx, op);
  if (op.previous_target) {
    await ctx.engine.validateRecordedTarget(op.previous_target);
    await ctx.engine.start(op.previous_target.containerId);
  }
  const route = await ctx.routes.replace(current, op.previous_target);
  await ctx.engine.reloadProxy();
  const observation = await observePrevious(ctx, op);
  if (observation.route.fingerprint !== route.fingerprint) throw new Error('route conflict');
  await store.recordObservation(ctx.db, op.id, ctx.guard.instance, observation);
  return store.finalizeFailure(
    ctx.db,
    op.id,
    ctx.guard.instance,
    op.previous_target ? 'restored' : 'unavailable',
    'execution failed; verified compensation',
  );
}
export async function executeOperation(ctx: RunnerContext, opId: string): Promise<Operation> {
  let op = await store.operationById(ctx.db, opId);
  try {
    ctx.guard.assertLive();
    if (op.profile_hash !== ctx.profile.fingerprint) throw new Error('profile drift');
    if (op.phase === 'queued') {
      const route = await ctx.routes.read();
      if (route.target) await ctx.engine.validateRecordedTarget(route.target);
      op = await store.claimQueued(ctx.db, op.id, ctx.guard.instance, route);
    }
    if (op.phase !== 'preflighting') throw new Error('operation state conflict');
    await store.validatePreflight(ctx.db, op.id, ctx.guard.instance);
    if (!op.previous_target && !(await ctx.engine.inspectContainer(ctx.engine.candidateName(op))))
      await ctx.engine.initializeAppData(op.project_id, op);
    const id = await ctx.engine.ensureCandidate(op, 'read-only');
    op = await store.setPhase(
      ctx.db,
      op.id,
      ctx.guard.instance,
      ['preflighting'],
      'preflighting',
      id,
    );
    await ctx.engine.start(id);
    await ctx.engine.observeCandidate(op);
    op = await store.beginCutover(ctx.db, op.id, ctx.guard.instance);
    if (op.previous_target) {
      await ctx.engine.validateRecordedTarget(op.previous_target);
      await ctx.engine.stop(op.previous_target.containerId);
    }
    if (process.env.CASIMIR_TEST_FAILPOINT === 'after_old_stop_throw')
      throw new Error('injected execution failure');
    await ctx.engine.stop(id);
    await ctx.engine.removeOwned(id);
    const writableId = await ctx.engine.ensureCandidate(op, 'writable');
    op = await store.setPhase(
      ctx.db,
      op.id,
      ctx.guard.instance,
      ['cutover'],
      'verifying',
      writableId,
    );
    await ctx.engine.start(writableId);
    const observed = await ctx.engine.observeCandidate(op);
    const writers = await ctx.engine.listOwnedContainers();
    let count = 0;
    for (const c of writers) {
      const actual = await ctx.engine.inspectContainer(c.Id);
      if (actual.State.Running && actual.Mounts.some((m: any) => m.Destination === '/data' && m.RW))
        count++;
    }
    if (count !== 1) throw new Error('writer overlap');
    const current = await ctx.routes.read();
    if (current.fingerprint !== digest(routeConfig(op.previous_target)))
      throw new Error('route conflict');
    const route = await ctx.routes.replace(current, observed.target);
    await ctx.engine.reloadProxy();
    const observation = await ctx.engine.runLoopbackProbe(observed.target, route, op);
    op = await store.recordObservation(ctx.db, op.id, ctx.guard.instance, observation);
    if (process.env.CASIMIR_TEST_FAILPOINT === 'after_route_throw')
      throw new Error('injected execution failure');
    if (process.env.CASIMIR_TEST_FAILPOINT === 'after_route_before_commit') {
      console.log('Casimir test checkpoint after_route_before_commit', op.id);
      await new Promise<void>((_, reject) =>
        ctx.guard.signal.addEventListener(
          'abort',
          () => reject(new Error('executor session lost')),
          { once: true },
        ),
      );
    }
    ctx.guard.assertLive();
    return await store.finalizeSuccess(ctx.db, op.id, ctx.guard.instance);
  } catch (error) {
    ctx.guard.assertLive();
    op = await store.operationById(ctx.db, opId);
    const message = (error as Error).message;
    if (
      /conflict|identity|recipe|profile|foreign|invalid|overlap/.test(message) ||
      op.phase === 'queued'
    )
      return store.blockOperation(ctx.db, op.id, 'execution state requires operator recovery');
    try {
      if (op.phase === 'preflighting') {
        await cleanupCandidate(ctx, op);
        const observation = await observePrevious(ctx, op);
        await store.recordObservation(ctx.db, op.id, ctx.guard.instance, observation);
        return await store.finalizeFailure(
          ctx.db,
          op.id,
          ctx.guard.instance,
          'rejected',
          'candidate preflight failed',
        );
      }
      return await compensate(ctx, op);
    } catch {
      ctx.guard.assertLive();
      return store.blockOperation(ctx.db, op.id, 'compensation could not be verified');
    }
  }
}
