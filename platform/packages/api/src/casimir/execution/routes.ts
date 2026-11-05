import type { Hono } from 'hono';
import type { Db } from '../../db/client.ts';
import { requireProjectCapability } from '../../project-access.ts';
import type { User } from '../../types.ts';
import { LocalHttpError } from '../project-service.ts';
import { admitExecution, readOperation, receipt } from './store.ts';
import type { ExecutionProfile } from './types.ts';
export function attachExecutionRoutes(
  app: Hono<{ Variables: { actor: User } }>,
  { db, profile }: { db: Db; profile?: ExecutionProfile },
) {
  app.post('/projects/:id/deployments/:deploymentId/execute', async (c) => {
    if (!profile) {
      await requireProjectCapability(db, c.req.param('id'), c.get('actor').id, 'deploy');
      return c.json({ error: 'execution profile unavailable' }, 501);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new LocalHttpError(400, 'invalid execution request');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).join(',') !== 'imageAlias' ||
      !('imageAlias' in body) ||
      typeof body.imageAlias !== 'string'
    )
      throw new LocalHttpError(400, 'invalid execution request');
    const op = await admitExecution(
      db,
      c.get('actor').id,
      c.req.param('id'),
      c.req.param('deploymentId'),
      c.req.header('Idempotency-Key') ?? '',
      body.imageAlias,
      profile,
    );
    return c.json(await receipt(db, op), 202);
  });
  app.get('/projects/:id/operations/:operationId', async (c) => {
    if (!profile) {
      await requireProjectCapability(db, c.req.param('id'), c.get('actor').id, 'read');
      return c.json({ error: 'execution profile unavailable' }, 501);
    }
    const op = await readOperation(
      db,
      c.get('actor').id,
      c.req.param('id'),
      c.req.param('operationId'),
    );
    if (!op) throw new LocalHttpError(404, 'operation not found');
    return c.json(await receipt(db, op));
  });
}
