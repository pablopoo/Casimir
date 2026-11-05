import { PLAN_EDITABLE_LIMIT_KEYS, parsePlatformPlanId } from '@void/platform/plans';
import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { OperatorError, readBody } from './common.ts';
import {
  getOperatorPlanCatalog,
  mutateOperatorPlanCatalog,
  syncOperatorPlanCatalog,
} from './plans.ts';

export const planOperatorRoutes = new Hono<ApiEnv>();

planOperatorRoutes.get('/config/plans', async (context) =>
  context.json({
    ...(await getOperatorPlanCatalog(context)),
    editableLimits: PLAN_EDITABLE_LIMIT_KEYS,
  }),
);
planOperatorRoutes.get('/config/plans/:id', async (context) => {
  const { catalog, accounts } = await getOperatorPlanCatalog(context);
  const plan = catalog.plans.find((plan) => plan.id === context.req.param('id'));
  if (!plan) {
    throw new OperatorError(404, 'Plan not found.', 'not_found');
  }
  return context.json({
    catalogRevision: catalog.revision,
    default: catalog.defaultPlanId === plan.id,
    plan,
    accounts: accounts.find((entry) => entry.planId === plan.id)?.count ?? 0,
  });
});
planOperatorRoutes.post('/config/plans/add', async (context) =>
  context.json(await mutateOperatorPlanCatalog(context, 'add', undefined, await readBody(context))),
);
planOperatorRoutes.post('/config/plans/default', async (context) =>
  context.json(
    await mutateOperatorPlanCatalog(context, 'default', undefined, await readBody(context)),
  ),
);
planOperatorRoutes.post('/config/plans/sync', async (context) => {
  const result = await syncOperatorPlanCatalog(context, await readBody(context));
  return context.json({
    ...result,
    ok: !('error' in result.reconciliation && result.reconciliation.error),
  });
});
for (const action of ['set', 'archive', 'remove', 'reset'] as const) {
  planOperatorRoutes.post(`/config/plans/:id/${action}`, async (context) => {
    let id: string;
    try {
      id = parsePlatformPlanId(context.req.param('id'));
    } catch (error) {
      throw new OperatorError(
        400,
        error instanceof Error ? error.message : 'Invalid plan ID.',
        'invalid_argument',
      );
    }
    return context.json(
      await mutateOperatorPlanCatalog(context, action, id, await readBody(context)),
    );
  });
}
