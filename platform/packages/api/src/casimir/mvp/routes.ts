import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../../db/client.ts';
import { getProjectBySlug } from '../../db/projects.ts';
import { requireProjectCapability } from '../../project-access.ts';
import type { User } from '../../types.ts';
import { LocalHttpError } from '../project-service.ts';
import { createMvpUpload, receiveMvpUpload, finalizeMvpUpload } from './artifacts.ts';
import {assertAdmissionCapacity} from '../lifecycle/capacity.ts';
import { assertMvpMigrations, admitArtifactDeployment, readMvpOperation } from './store.ts';
import type { MvpProfile } from './types.ts';
async function body(request: Request, keys: Array<string>): Promise<Record<string, unknown>> {
  let value;
  try {
    value = await request.json();
  } catch {
    throw new LocalHttpError(400, 'invalid JSON body');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  ) {
    throw new LocalHttpError(400, 'invalid request fields');
  }
  return value as Record<string, unknown>;
}
function param(value: string | undefined): string {
  if (!value) {
    throw new LocalHttpError(400, 'missing route parameter');
  }
  return value;
}
export function attachMvpRoutes(
  app: Hono<{ Variables: { actor: User } }>,
  { db, profile }: { db: Db; profile: MvpProfile },
): void {
  const base = '/casimir/v1/projects/:projectId';
  app.get('/projects/by-slug/:slug', async (c) => {
    const project = await getProjectBySlug(db, param(c.req.param('slug')));
    if (!project) {
      throw new LocalHttpError(404, 'project not found');
    }
    await requireProjectCapability(db, project.id, c.get('actor').id, 'read');
    return c.json(project);
  });
  app.use('/casimir/v1/*', async (_c, next) => {
    await assertMvpMigrations(db);
    await next();
  });
  // Binary route intentionally precedes every JSON body-limit middleware.
  app.put(base + '/uploads/:uploadId/content', async (c) => {
    await receiveMvpUpload(
      db,
      profile,
      c.get('actor').id,
      param(c.req.param('projectId')),
      param(c.req.param('uploadId')),
      c.req.raw.body,
    );
    return c.json({ uploaded: true });
  });
  app.use(
    '/casimir/v1/*',
    bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: 'request body too large' }, 413) }),
  );
  app.get('/casimir/v1/identity', (c) => c.json({ actorId: c.get('actor').id }));
  app.post(base + '/uploads', async (c) => {
    const b = await body(c.req.raw, ['bytes', 'sha256']);
    await assertAdmissionCapacity(profile,b.bytes);
    return c.json(
      await createMvpUpload(
        db,
        profile,
        c.get('actor').id,
        param(c.req.param('projectId')),
        b.bytes,
        b.sha256,
      ),
      201,
    );
  });
  app.post(base + '/uploads/:uploadId/finalize', async (c) => {
    await body(c.req.raw, []);
    return c.json(
      await finalizeMvpUpload(
        db,
        profile,
        c.get('actor').id,
        param(c.req.param('projectId')),
        param(c.req.param('uploadId')),
      ),
    );
  });
  app.post(base + '/deployments', async (c) => {
    const b = await body(c.req.raw, ['artifactId']);
    if (typeof b.artifactId !== 'string') {
      throw new LocalHttpError(400, 'invalid artifact ID');
    }
    await assertAdmissionCapacity(profile);
    return c.json(
      await admitArtifactDeployment(
        db,
        c.get('actor').id,
        param(c.req.param('projectId')),
        b.artifactId,
        c.req.header('Idempotency-Key') ?? '',
        profile.runtime,
        profile.installationId,
      ),
      202,
    );
  });
  app.get(base + '/operations/:id', async (c) =>
    c.json(
      await readMvpOperation(
        db,
        c.get('actor').id,
        param(c.req.param('projectId')),
        param(c.req.param('id')),
      ),
    ),
  );
  app.get(base + '/deployments', async (c) => {
    await requireProjectCapability(db, param(c.req.param('projectId')), c.get('actor').id, 'read');
    const result = await db.execute<{ id: string }>(
      sql`SELECT id FROM casimir_mvp_a.operations WHERE project_id=${param(c.req.param('projectId'))} ORDER BY created_at DESC LIMIT 20`,
    );
    return c.json({
      operations: await Promise.all(
        result.rows.map((row) =>
          readMvpOperation(db, c.get('actor').id, param(c.req.param('projectId')), row.id),
        ),
      ),
    });
  });
}
