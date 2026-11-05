import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { createDeployment } from '../db/deployments.ts';
import { requireProjectCapability } from '../project-access.ts';
import { requireNormalizedProject } from '../project-state.ts';
import { LocalHttpError } from './project-service.ts';

/** Records intent only: no queue, execution, route publication or activation. */
export async function recordDeployment(db: Db, actorId: string, projectId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const access = await requireProjectCapability(tx, projectId, actorId, 'deploy');
    if (access.project.status === 'deleting')
      throw new LocalHttpError(410, 'project is being deleted');
    await requireNormalizedProject(tx, access.project);
    return createDeployment(tx, projectId, null, 'casimir-record', null, {
      billingUserId: access.owner.id,
      initiatedByUserId: actorId,
    });
  });
}
