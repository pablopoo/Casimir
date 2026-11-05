import type { MvpCleanupJob } from './engine.ts';
import { mvpOperationById, type MvpContext } from './runner.ts';
import type { MvpOperation } from './types.ts';
export { reconcileMvpOperation } from './runner.ts';

/** Exited job containers are disposable only after the operation is terminal. */
export async function cleanupMvpOperationJobs(
  ctx: MvpContext,
  op: MvpOperation,
): Promise<Array<string>> {
  ctx.guard.assertLive();
  if (!['succeeded', 'failed'].includes(op.phase)) {
    return [];
  }
  const value = op.previous_target?.jobs;
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('job_journal_invalid');
  }
  const jobs: Array<MvpCleanupJob> = [];
  for (const raw of Object.values(value ?? {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('job_journal_invalid');
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      !/^[a-f0-9]{32}$/.test(row.id) ||
      typeof row.action !== 'string' ||
      typeof row.releaseId !== 'string' ||
      !/^cmv_[a-z0-9]{12}$/.test(row.releaseId) ||
      !row.parameters ||
      typeof row.parameters !== 'object' ||
      Array.isArray(row.parameters)
    ) {
      throw new Error('job_journal_invalid');
    }
    const release = await mvpOperationById(ctx, row.releaseId);
    if (release.project_id !== op.project_id) {
      throw new Error('job_journal_invalid');
    }
    jobs.push({
      id: row.id,
      action: row.action,
      parameters: row.parameters as Record<string, unknown>,
      release,
    });
  }
  return ctx.engine.cleanupOperationJobs(op, jobs);
}
