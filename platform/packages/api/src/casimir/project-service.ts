import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { createProject, getProjectBySlug } from '../db/projects.ts';
import { resolvePlan } from '../plans.ts';
import { validateProjectSlug } from '../project-creation-policy.ts';
import { users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

export class LocalHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 507,
    message: string,
  ) {
    super(message);
  }
}

export async function createLocalProject(db: Db, actorId: string, slug: unknown) {
  const problem = validateProjectSlug(slug);
  if (problem) throw new LocalHttpError(400, problem);
  const name = slug as string;
  return db.transaction(async (tx) => {
    const [actor] = await tx.select().from(users).where(eq(users.id, actorId)).limit(1);
    if (!actor) throw new LocalHttpError(401, 'operator unavailable');
    if (isAdminSuspended(actor.suspended_reason))
      throw new LocalHttpError(403, 'account suspended');
    if (name.length <= 5 && !(await resolvePlan(tx, actor.plan)).allowShortSlugs) {
      throw new LocalHttpError(
        403,
        'the selected plan does not permit short slugs (5 characters or fewer)',
      );
    }
    if (await getProjectBySlug(tx, name)) throw new LocalHttpError(409, 'slug already taken');
    return createProject(tx, actorId, name);
  });
}
