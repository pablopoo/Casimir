import {
  createFateServer,
  resolveSourceById,
  type SourceDefinition,
  type SourceRegistry,
} from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { PlatformManagementEnv } from '../../env.ts';
import { checkDatabaseHealth, type HealthCheck } from '../../operator/system-health-contract.ts';
import { systemOverviewBase } from '../../operator/system-overview.ts';
import { loadPageRecords, requestTimezone } from './page-requests.ts';
import {
  loadProjectsPage,
  projectWithPageUrl,
  projectsPageDataView,
  type ProjectPageUrlResolver,
  type ProjectsPageRecord,
} from './projects-page.ts';
import {
  loadProjectDetailPage,
  projectDetailDataView,
  type ProjectDetailPageOptions,
  type ProjectDetailRecord,
  type ProjectDetailUrlResolver,
} from './project-detail-page.ts';
import {
  deploymentsPageDataView,
  loadDeploymentsPage,
  type DeploymentsPageRecord,
} from './deployments-page.ts';
import {
  deploymentDetailDataView,
  loadDeploymentDetailPage,
  type DeploymentDetailRecord,
} from './deployment-detail-page.ts';
import {
  dashboardDataView,
  healthDataView,
  topProjectDataView,
  type DashboardRecord,
  type HealthRecord,
  type TopProjectRecord,
} from './dashboard-contracts.ts';

type ProjectsContext = Context<PlatformManagementEnv>;
export type ManagementApiHealthProbe = () => Promise<HealthCheck>;
const projectsSource: SourceDefinition<ProjectsPageRecord> = {
  id: 'id',
  view: projectsPageDataView,
};
const projectDetailSource: SourceDefinition<ProjectDetailRecord> = {
  id: 'id',
  view: projectDetailDataView,
};
const deploymentsSource: SourceDefinition<DeploymentsPageRecord> = {
  id: 'id',
  view: deploymentsPageDataView,
};
const deploymentDetailSource: SourceDefinition<DeploymentDetailRecord> = {
  id: 'id',
  view: deploymentDetailDataView,
};
const topProjectSource: SourceDefinition<TopProjectRecord> = {
  id: 'id',
  view: topProjectDataView,
};
const dashboardSource: SourceDefinition<DashboardRecord> = {
  id: 'id',
  view: dashboardDataView,
  relations: {
    topProjects: {
      kind: 'many',
      foreignKey: 'dashboardId',
      localKey: 'id',
      source: topProjectSource,
    },
  },
};
const healthSource: SourceDefinition<HealthRecord> = { id: 'id', view: healthDataView };

function pagePath(input: { args?: Record<string, unknown> }) {
  const path = input.args?.path;
  if (typeof path !== 'string') {
    throw new Error('Admin page path is required.');
  }
  return path;
}

export function createManagementProjectsFateServer(
  resolveProjectUrl?: ProjectPageUrlResolver,
  resolveProjectDetailUrl?: ProjectDetailUrlResolver,
  apiHealthProbe?: ManagementApiHealthProbe,
) {
  const projectsRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      projectsSource,
      {
        byIds: async ({ ctx, ids }) =>
          loadPageRecords(ids, (id) => loadProjectsPage(ctx, id, resolveProjectUrl)),
      },
    ],
  ]);
  const projectDetailRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      projectDetailSource,
      {
        byIds: async ({ ctx, ids }) =>
          loadPageRecords(ids, (id) =>
            loadProjectDetailPage(ctx, id, {
              resolveProjectUrl: resolveProjectDetailUrl,
            } satisfies ProjectDetailPageOptions),
          ),
      },
    ],
  ]);
  const deploymentsRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      deploymentsSource,
      {
        byIds: async ({ ctx, ids }) =>
          loadPageRecords(ids, (id) => loadDeploymentsPage(ctx, id)),
      },
    ],
  ]);
  const deploymentDetailRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      deploymentDetailSource,
      {
        byIds: async ({ ctx, ids }) =>
          loadPageRecords(ids, (id) => loadDeploymentDetailPage(ctx, id)),
      },
    ],
  ]);
  const dashboardRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      dashboardSource,
      {
        byIds: async ({ ctx, ids }) => {
          const base = await systemOverviewBase(ctx.get('db'), ctx.env);
          return ids
            .filter((id) => id === 'overview')
            .map((id) => ({
              id,
              ...base,
              userCount: base.stats.users,
              projectCount: base.stats.projects,
              deploymentCount: base.stats.deployments,
              tz: requestTimezone(ctx),
              trafficAvailable: false,
              projects: base.projects.map((project) =>
                projectWithPageUrl(ctx, project, resolveProjectUrl),
              ),
              topProjects: [],
            })) as Array<DashboardRecord>;
        },
      },
    ],
  ]);
  const healthRegistry: SourceRegistry<ProjectsContext> = new Map([
    [
      healthSource,
      {
        byIds: async ({ ctx, ids }) => {
          if (!ids.includes('health')) return [];
          const apiCheck = await apiHealthProbe?.();
          const checks = [
            ...(apiCheck ? [apiCheck] : []),
            await checkDatabaseHealth(ctx.get('db')),
          ];
          return [
            {
              id: 'health',
              allOk: false,
              checks,
              checkedAt: Date.now(),
            },
          ];
        },
      },
    ],
  ]);
  const sources = new Map<string, unknown>([
    ['AdminDashboard', dashboardSource],
    ['AdminHealth', healthSource],
    ['AdminTopProject', topProjectSource],
    ['AdminProjectsPage', projectsSource],
    ['AdminProjectDetail', projectDetailSource],
    ['AdminDeploymentsPage', deploymentsSource],
    ['AdminDeploymentDetail', deploymentDetailSource],
  ]);
  return createFateServer({
    context: ({ adapterContext }: { adapterContext?: ProjectsContext }) => {
      if (!adapterContext) {
        throw new Error('Admin Fate requires an authenticated request context.');
      }
      return adapterContext;
    },
    queries: {
      dashboard: {
        resolve: ({ ctx, select }: { ctx: ProjectsContext; select: Array<string> }) =>
          resolveSourceById({
            ctx,
            id: 'overview',
            input: { select },
            registry: dashboardRegistry,
            source: dashboardSource,
          }),
      },
      health: {
        resolve: ({ ctx, select }: { ctx: ProjectsContext; select: Array<string> }) =>
          resolveSourceById({
            ctx,
            id: 'health',
            input: { select },
            registry: healthRegistry,
            source: healthSource,
          }),
      },
      projectsPage: {
        resolve: ({
          ctx,
          input,
          select,
        }: {
          ctx: ProjectsContext;
          input: { args?: Record<string, unknown> };
          select: Array<string>;
        }) =>
          resolveSourceById({
            ctx,
            id: pagePath(input),
            input: { select },
            registry: projectsRegistry,
            source: projectsSource,
          }),
      },
      projectDetail: {
        resolve: ({
          ctx,
          input,
          select,
        }: {
          ctx: ProjectsContext;
          input: { args?: Record<string, unknown> };
          select: Array<string>;
        }) =>
          resolveSourceById({
            ctx,
            id: pagePath(input),
            input: { select },
            registry: projectDetailRegistry,
            source: projectDetailSource,
          }),
      },
      deploymentsPage: {
        resolve: ({
          ctx,
          input,
          select,
        }: {
          ctx: ProjectsContext;
          input: { args?: Record<string, unknown> };
          select: Array<string>;
        }) =>
          resolveSourceById({
            ctx,
            id: pagePath(input),
            input: { select },
            registry: deploymentsRegistry,
            source: deploymentsSource,
          }),
      },
      deploymentDetail: {
        resolve: ({
          ctx,
          input,
          select,
        }: {
          ctx: ProjectsContext;
          input: { args?: Record<string, unknown> };
          select: Array<string>;
        }) =>
          resolveSourceById({
            ctx,
            id: pagePath(input),
            input: { select },
            registry: deploymentDetailRegistry,
            source: deploymentDetailSource,
          }),
      },
    },
    roots: {
      dashboard: dashboardDataView,
      health: healthDataView,
      projectsPage: projectsPageDataView,
      projectDetail: projectDetailDataView,
      deploymentsPage: deploymentsPageDataView,
      deploymentDetail: deploymentDetailDataView,
    },
    sources: {
      getSource: <Item extends Record<string, unknown>>(
        target: { typeName: string } | SourceDefinition<Item>,
      ) => {
        const typeName = 'view' in target ? target.view.typeName : target.typeName;
        const source = sources.get(typeName);
        if (!source) {
          throw new Error(`Unknown management Fate source: ${typeName}`);
        }
        return source as SourceDefinition<Item>;
      },
      registry: new Map([
        ...dashboardRegistry,
        ...healthRegistry,
        ...projectsRegistry,
        ...projectDetailRegistry,
        ...deploymentsRegistry,
        ...deploymentDetailRegistry,
      ]),
    },
  });
}

export const managementProjectsFateServer = createManagementProjectsFateServer();
