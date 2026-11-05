import { FateRequestError } from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { PlatformManagementEnv } from '../../env.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderAdminPage } from '../react/server.ts';
import { createFateClient } from './client.generated.ts';
import { projectsPageRequest } from './views.ts';

export async function renderFateProjectsPage<E extends PlatformManagementEnv>(
  context: Context<E>,
  handleFateRequest: (request: Request, context: Context<E>) => Response | Promise<Response>,
): Promise<Response> {
  const { pathname, search } = new URL(context.req.url);
  const path = pathname + search;
  const platformName = getPlatformDisplayName(context.env, context.req.url);
  const props = {
    path,
    platformName,
    username: context.get('user').login,
  };
  if (context.req.header('X-VoidPages') === 'true') {
    return renderAdminPage(context, 'projects', 'Projects', props);
  }

  const client = createFateClient({
    url: new URL('/admin/fate', context.req.url),
    fetch: async (input, init) => handleFateRequest(new Request(input, init), context),
  });
  try {
    await client.request(projectsPageRequest(path));
    return renderAdminPage(context, 'projects', 'Projects', props, { fateSnapshot: client.dehydrate() });
  } catch (error) {
    if (error instanceof FateRequestError && error.status >= 400 && error.status < 500) {
      return renderAdminPage(
        context,
        'adminError',
        'Admin error',
        {
          message: error.message,
          status: error.status,
          platformName,
          username: props.username,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
