import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/client.ts';
import { getProjectDeployments } from '../db/deployments.ts';
import {
  ProjectNotFoundError,
  ProjectAccessDeniedError,
  requireProjectCapability,
} from '../project-access.ts';
import { ProjectRequiresNormalizationError } from '../project-state.ts';
import { users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import type { User } from '../types.ts';
import { recordDeployment } from './deployment-records.ts';
import { attachExecutionRoutes } from './execution/routes.ts';
import { assertExecutionMigrations } from './execution/store.ts';
import type { ExecutionProfile } from './execution/types.ts';
import { attachMvpRoutes } from './mvp/routes.ts';
import { assertMvpMigrations } from './mvp/store.ts';
import type { MvpProfile } from './mvp/types.ts';
import { LocalHttpError, createLocalProject } from './project-service.ts';
import type { CasimirManagementConfig } from './management/enrollment.ts';
import type { ManagementApiHealthProbe } from '../admin/fate/projects-server.ts';
import {
  createCasimirManagementFetchHandler,
  type CasimirAdminAssets,
} from './management/host.ts';

export function canonicalOriginHostname(origin: string): string {
  const hostname = new URL(origin).hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new LocalHttpError(400, 'invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new LocalHttpError(400, 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

export function createApp({
  db,
  token,
  operatorId,
  profile,
  mvpProfile,
  management,
}: {
  db: Db;
  token: string;
  operatorId: string;
  profile?: ExecutionProfile;
  mvpProfile?: MvpProfile;
  management?: {
    config: CasimirManagementConfig;
    controlOrigin: string;
    authSetupCommand?: string;
    assets: CasimirAdminAssets;
    apiHealthProbe?: ManagementApiHealthProbe;
  };
}) {
  const managementAppOrigin = mvpProfile?.origins?.app;
  if (
    management &&
    (!mvpProfile?.installationId ||
      !managementAppOrigin ||
      management.config.installationId !== mvpProfile.installationId ||
      management.config.operatorId !== operatorId ||
      management.controlOrigin !== mvpProfile.origins?.control)
  ) {
    throw new Error('Casimir management profile identity mismatch');
  }
  if (
    management &&
    mvpProfile?.origins &&
    canonicalOriginHostname(management.controlOrigin) ===
      canonicalOriginHostname(mvpProfile.origins.app)
  ) {
    throw new Error('Casimir management control and app origins must use separate hostnames');
  }
  const app = new Hono<{ Variables: { actor: User } }>();
  if (mvpProfile?.origins) {
    app.use('*', async (context, next) => {
      const origin = context.req.header('Origin');
      if (origin && origin !== mvpProfile.origins!.control) return context.json({error:'origin_forbidden'}, 403);
      await next();
    });
  }
  const expected = createHash('sha256').update(token).digest();
  const expectedMigrations: number = JSON.parse(
    readFileSync('platform/packages/api/drizzle/meta/_journal.json', 'utf8'),
  ).entries.length;
  app.get('/health', async (context) => {
    try {
      const result = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );
      if (result.rows[0]?.count !== expectedMigrations) return context.json({ ready: false }, 503);
      if (profile) await assertExecutionMigrations(db);
      if (mvpProfile) {
        await assertMvpMigrations(db);
      }
      return context.json({ ready: true });
    } catch {
      return context.json({ ready: false }, 503);
    }
  });
  if (mvpProfile) {
    app.get('/casimir/v1/info', (c) => c.json(mvpProfile.runtime));
  }
  app.use('*', async (context, next) => {
    const header = context.req.header('Authorization');
    if (
      !header?.startsWith('Bearer ') ||
      !timingSafeEqual(expected, createHash('sha256').update(header.slice(7)).digest())
    ) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    const [actor] = await db.select().from(users).where(eq(users.id, operatorId)).limit(1);
    if (!actor) return context.json({ error: 'operator unavailable' }, 401);
    if (isAdminSuspended(actor.suspended_reason))
      return context.json({ error: 'account suspended' }, 403);
    context.set('actor', actor);
    await next();
  });
  if (mvpProfile) {
    attachMvpRoutes(app, { db, profile: mvpProfile });
  }
  app.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) => context.json({ error: 'request body too large' }, 413),
    }),
  );
  app.post('/projects', async (context) => {
    const body = await objectBody(context.req.raw);
    const project = await createLocalProject(db, context.get('actor').id, body.slug);
    return context.json(project, 201);
  });
  app.get('/projects/:id', async (context) => {
    const access = await requireProjectCapability(
      db,
      context.req.param('id'),
      context.get('actor').id,
      'read',
    );
    return context.json(access.project);
  });
  app.post('/projects/:id/deployments', async (context) => {
    const body = await objectBody(context.req.raw);
    if (Object.keys(body).length)
      throw new LocalHttpError(400, 'deployment records accept an empty object only');
    return context.json(
      await recordDeployment(db, context.get('actor').id, context.req.param('id')),
      201,
    );
  });
  app.get('/projects/:id/deployments', async (context) => {
    const access = await requireProjectCapability(
      db,
      context.req.param('id'),
      context.get('actor').id,
      'read',
    );
    const deployments = await getProjectDeployments(db, access.project.id, 20);
    return context.json({ deployments, activeDeploymentId: access.project.active_deployment_id });
  });
  app.post('/projects/:id/deploy', async (context) => {
    await requireProjectCapability(db, context.req.param('id'), context.get('actor').id, 'deploy');
    return context.json({ error: 'deployment execution is unsupported' }, 501);
  });
  attachExecutionRoutes(app, { db, profile });
  app.onError((error, context) => {
    if (
      error instanceof LocalHttpError ||
      error instanceof ProjectNotFoundError ||
      error instanceof ProjectAccessDeniedError
    ) {
      return context.json({ error: error.message }, error.status);
    }
    if (error instanceof ProjectRequiresNormalizationError)
      return context.json({ error: error.code }, 409);
    const cause = (error as Error & { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === '23505' && cause.constraint?.includes('slug'))
      return context.json({ error: 'slug already taken' }, 409);
    return context.json({ error: 'database or internal operation unavailable' }, 503);
  });
  const managementFetch = management && managementAppOrigin
    ? createCasimirManagementFetchHandler({
        db,
        config: management.config,
        controlOrigin: management.controlOrigin,
        appOrigin: managementAppOrigin,
        authSetupCommand: management.authSetupCommand,
        assets: management.assets,
        apiHealthProbe: management.apiHealthProbe,
        dispatch: app.fetch.bind(app),
      })
    : undefined;
  if (managementFetch) {
    app.fetch = managementFetch;
  }
  let closePromise: Promise<void> | undefined;
  return Object.assign(app, {
    close() {
      closePromise ??= managementFetch?.close() ?? Promise.resolve();
      return closePromise;
    },
  });
}
