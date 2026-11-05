import type { Context } from 'hono';
import type { PlatformManagementEnv } from '../../env.ts';
import { systemHealthCheckNames } from '../../operator/system-health-contract.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderAdminPage } from '../react/server.ts';
import { createFateClient } from './client.generated.ts';
import { dashboardRequest } from './views.ts';

export async function renderDashboardFatePageWith<E extends PlatformManagementEnv>(
  context: Context<E>,
  handleFateRequest: (request: Request, context: Context<E>) => Response | Promise<Response>,
): Promise<Response> {
  const props = {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
    healthCheckNames: systemHealthCheckNames(Boolean(context.env.PLATFORM_INSTALLATION_ID)),
  };
  // Page-object navigations carry a cheap route shell. The persistent browser
  // Fate client resolves it from cache or requests the missing view.
  if (context.req.header('X-VoidPages') === 'true') {
    return renderAdminPage(context, 'dashboard', 'Dashboard', props);
  }

  const client = createFateClient({
    url: new URL('/admin/fate', context.req.url),
    fetch: async (input, init) => handleFateRequest(new Request(input, init), context),
  });
  await client.request(dashboardRequest);
  return renderAdminPage(context, 'dashboard', 'Dashboard', props, {
    fateSnapshot: client.dehydrate(),
  });
}
