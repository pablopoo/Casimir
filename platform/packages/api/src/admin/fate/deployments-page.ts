import { dataView, type Entity } from '@nkzw/fate/server';
import type { Context } from 'hono';
import { countDeployments, getAllDeploymentsWithProject, searchDeployments } from '../../db.ts';
import type { PlatformManagementEnv } from '../../env.ts';
import { ADMIN_PAGE_SIZE, pageLocation, pageNumber, requestTimezone } from './page-requests.ts';

export async function loadDeploymentsPage<E extends PlatformManagementEnv>(
  context: Context<E>,
  path: string,
) {
  const url = pageLocation(path, '/admin/deployments');
  const search = url.searchParams.get('search') ?? undefined;
  const tz = requestTimezone(context);
  if (search) {
    return {
      id: path,
      deployments: await searchDeployments(context.get('db'), search),
      search,
      tz,
    };
  }
  const page = pageNumber(url);
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(context.get('db'), ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE),
    countDeployments(context.get('db')),
  ]);
  return {
    id: path,
    deployments,
    page,
    totalPages: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)),
    tz,
  };
}

export type DeploymentsPageRecord = Awaited<ReturnType<typeof loadDeploymentsPage>>;

export const deploymentsPageDataView = dataView<DeploymentsPageRecord>('AdminDeploymentsPage')({
  id: true,
  deployments: true,
  search: true,
  page: true,
  totalPages: true,
  tz: true,
});

export type AdminDeploymentsPage = Entity<typeof deploymentsPageDataView, 'AdminDeploymentsPage'>;
