import { FateRequestError } from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { PlatformManagementEnv } from '../../env.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderAdminPage } from '../react/server.ts';
import { createFateClient } from './client.generated.ts';
import { DeploymentDetailView, deploymentDetailRequest } from './views.ts';

export async function renderFateDeploymentDetailPage<E extends PlatformManagementEnv>(
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
    return renderAdminPage(context, 'deploymentDetail', 'Deployment', props);
  }

  const client = createFateClient({
    url: new URL('/admin/fate', context.req.url),
    fetch: async (input, init) => handleFateRequest(new Request(input, init), context),
  });
  try {
    const { deploymentDetail } = await client.request(deploymentDetailRequest(path));
    if (!deploymentDetail) {
      throw new FateRequestError('NOT_FOUND', 'Deployment not found');
    }
    const { data } = await client.readView(DeploymentDetailView, deploymentDetail);
    const title = `Deployment ${(data as unknown as { deployment: { id: string } }).deployment.id}`;
    return renderAdminPage(context, 'deploymentDetail', title, props, {
      fateSnapshot: client.dehydrate(),
    });
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
