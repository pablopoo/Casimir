import { FateRequestError } from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderAdminPage } from '../react/server.ts';
import { createFateClient } from './client.generated.ts';
import { fateServer } from './server.ts';
import { renderDashboardFatePageWith } from './render-dashboard-page.ts';
import { renderFateProjectsPage } from './render-projects-page.ts';
import { renderFateProjectDetailPage } from './render-project-detail-page.ts';
import { renderFateDeploymentsPage } from './render-deployments-page.ts';
import { renderFateDeploymentDetailPage } from './render-deployment-detail-page.ts';
import {
  plansRequest,
  BuildDetailView,
  UserDetailView,
  buildDetailRequest,
  authSettingsRequest,
  authNewRequest,
  authEditRequest,
  emailSettingsRequest,
  emailProjectRequest,
  EmailProjectView,
  cliVersionsRequest,
  invitationsRequest,
  signupRequest,
  userDetailRequest,
  usersPageRequest,
  zeroTrustRequest,
} from './views.ts';

function createServerClient(context: Context<ApiEnv>) {
  return createFateClient({
    url: new URL('/admin/fate', context.req.url),
    fetch: (input, init) => fateServer.handleRequest(new Request(input, init), context),
  });
}

export async function renderDashboardFatePage(context: Context<ApiEnv>): Promise<Response> {
  return renderDashboardFatePageWith(context, (request, currentContext) =>
    fateServer.handleRequest(request, currentContext),
  );
}

export async function renderFateListPage(
  context: Context<ApiEnv>,
  page:
    | 'plans'
    | 'planEdit'
    | 'users'
    | 'projects'
    | 'deployments'
    | 'cliVersions'
    | 'signupControl'
    | 'invitations'
    | 'authSettings'
    | 'authNew'
    | 'authEdit'
    | 'email'
    | 'zeroTrust',
): Promise<Response> {
  const title = {
    plans: 'Plans',
    planEdit: 'Plan',
    users: 'Users',
    projects: 'Projects',
    deployments: 'Deployments',
    cliVersions: 'CLI Versions',
    signupControl: 'Access',
    invitations: 'Invitations',
    authSettings: 'Authentication settings',
    authNew: 'Add login method',
    authEdit: 'Edit login method',
    email: 'Email',
    zeroTrust: 'Zero Trust',
  }[page];
  const { pathname, search } = new URL(context.req.url);
  const path = pathname + search;
  const props = {
    path,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  };
  if (page === 'projects') {
    return renderFateProjectsPage(context, (request, currentContext) =>
      fateServer.handleRequest(request, currentContext),
    );
  }
  if (page === 'deployments') {
    return renderFateDeploymentsPage(context, (request, currentContext) =>
      fateServer.handleRequest(request, currentContext),
    );
  }
  if (context.req.header('X-VoidPages') === 'true') {
    return renderAdminPage(context, page, title, props);
  }

  const client = createServerClient(context);
  try {
    if (page === 'plans' || page === 'planEdit') {
      await client.request(plansRequest(path));
    } else if (page === 'users') {
      await client.request(usersPageRequest(path));
    } else if (page === 'cliVersions') {
      await client.request(cliVersionsRequest(path));
    } else if (page === 'signupControl') {
      await client.request(signupRequest(path));
    } else if (page === 'invitations') {
      await client.request(invitationsRequest(path));
    } else if (page === 'authSettings') {
      await client.request(authSettingsRequest(path));
    } else if (page === 'authNew') {
      await client.request(authNewRequest(path));
    } else if (page === 'authEdit') {
      await client.request(authEditRequest(path));
    } else if (page === 'zeroTrust') {
      await client.request(zeroTrustRequest(path));
    } else {
      await client.request(emailSettingsRequest(path));
    }
    return renderAdminPage(context, page, title, props, { fateSnapshot: client.dehydrate() });
  } catch (error) {
    if (error instanceof FateRequestError && error.status >= 400 && error.status < 500) {
      const authPage = page === 'authSettings' || page === 'authNew' || page === 'authEdit';
      return renderAdminPage(
        context,
        authPage ? 'authError' : 'adminError',
        authPage ? 'Authentication settings' : 'Admin error',
        {
          message: error.message,
          status: error.status,
          platformName: props.platformName,
          username: props.username,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}

export async function renderFateDetailPage(
  context: Context<ApiEnv>,
  page: 'userDetail' | 'projectDetail' | 'deploymentDetail' | 'buildDetail' | 'emailProject',
): Promise<Response> {
  const { pathname, search } = new URL(context.req.url);
  const path = pathname + search;
  const title =
    page === 'userDetail'
      ? 'User'
      : page === 'projectDetail'
        ? 'Project'
        : page === 'deploymentDetail'
          ? 'Deployment'
          : page === 'emailProject'
            ? 'Email'
            : 'Build';
  const props = {
    path,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  };
  if (page === 'projectDetail') {
    return renderFateProjectDetailPage(context, (request, currentContext) =>
      fateServer.handleRequest(request, currentContext),
    );
  }
  if (page === 'deploymentDetail') {
    return renderFateDeploymentDetailPage(context, (request, currentContext) =>
      fateServer.handleRequest(request, currentContext),
    );
  }
  if (context.req.header('X-VoidPages') === 'true') {
    return renderAdminPage(context, page, title, props);
  }

  const client = createServerClient(context);
  try {
    let detailTitle = title;
    if (page === 'userDetail') {
      const { userDetail } = await client.request(userDetailRequest(path));
      if (!userDetail) {
        throw new FateRequestError('NOT_FOUND', 'User not found');
      }
      const { data } = await client.readView(UserDetailView, userDetail);
      detailTitle = (data as unknown as { user: { login: string } }).user.login;
    } else if (page === 'buildDetail') {
      const { buildDetail } = await client.request(buildDetailRequest(path));
      if (!buildDetail) {
        throw new FateRequestError('NOT_FOUND', 'Build not found');
      }
      const { data } = await client.readView(BuildDetailView, buildDetail);
      detailTitle = `Build ${(data as unknown as { build: { id: string } }).build.id}`;
    } else {
      const { emailProject } = await client.request(emailProjectRequest(path));
      if (!emailProject) {
        throw new FateRequestError('NOT_FOUND', 'Project not found');
      }
      const { data } = await client.readView(EmailProjectView, emailProject);
      detailTitle = `Email - ${(data as unknown as { project: { slug: string } }).project.slug}`;
    }
    return renderAdminPage(context, page, detailTitle, props, { fateSnapshot: client.dehydrate() });
  } catch (error) {
    if (error instanceof FateRequestError && error.status >= 400 && error.status < 500) {
      return renderAdminPage(
        context,
        'adminError',
        'Admin error',
        {
          message: error.message,
          status: error.status,
          platformName: props.platformName,
          username: props.username,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
