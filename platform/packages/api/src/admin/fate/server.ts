import {
  createFateServer,
  createHonoFateHandler,
  hasNestedSelection,
  resolveSourceById,
  type SourceDefinition,
  type SourcePlan,
  type SourceRegistry,
} from '@nkzw/fate/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  getTopProjectsLastHour,
  systemHealth,
  systemOverviewBase,
} from '../../operator/system-operations.ts';
import { projectWithUrl } from '../../project-url.ts';
import { requestTimezone } from './page-data.ts';
import {
  dashboardDataView,
  healthDataView,
  topProjectDataView,
} from './dashboard-contracts.ts';
import type {
  AdminDashboard,
  AdminHealth,
  AdminTopProject,
  DashboardRecord,
  HealthRecord,
  TopProjectRecord,
} from './dashboard-contracts.ts';
import { PageRoot, pageQueries, pageRegistry, pageSourceByType } from './page-server.ts';
import {
  telemetryQueries,
  telemetryRegistry,
  telemetryRoot,
  telemetrySources,
} from './telemetry.ts';
export type {
  AdminPlans,
  AdminUsersPage,
  AdminProjectsPage,
  AdminDeploymentsPage,
  AdminUserDetail,
  AdminProjectDetail,
  AdminDeploymentDetail,
  AdminBuildDetail,
  AdminCliVersions,
  AdminSignup,
  AdminInvitations,
  AdminAuthSettings,
  AdminAuthNew,
  AdminAuthEdit,
  AdminEmailSettings,
  AdminEmailProject,
  AdminZeroTrust,
} from './page-server.ts';
export type { AdminBuildLogs, AdminBuildStatus, AdminDeploymentLogs } from './telemetry.ts';
export { dashboardDataView, healthDataView, topProjectDataView } from './dashboard-contracts.ts';
export type { AdminDashboard, AdminHealth, AdminTopProject } from './dashboard-contracts.ts';

type AdminContext = Context<ApiEnv>;

const topProjectSource: SourceDefinition<TopProjectRecord> = {
  id: 'id',
  view: topProjectDataView,
};
const healthSource: SourceDefinition<HealthRecord> = { id: 'id', view: healthDataView };
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

const registry: SourceRegistry<AdminContext> = new Map(pageRegistry);
for (const [source, handler] of telemetryRegistry) {
  registry.set(source, handler);
}
registry.set(dashboardSource, {
  byIds: async ({
    ctx,
    ids,
    plan,
  }: {
    ctx: AdminContext;
    ids: Array<string>;
    plan: SourcePlan<DashboardRecord, AdminContext>;
  }) => {
    const needsTopProjects = hasNestedSelection(plan.selectedPaths, 'topProjects');
    const needsBase = [...plan.selectedPaths].some(
      (path) => path !== 'id' && !path.startsWith('topProjects.'),
    );
    const [base, topProjects] = await Promise.all([
      needsBase ? systemOverviewBase(ctx.get('db'), ctx.env) : null,
      needsTopProjects ? getTopProjectsLastHour(ctx.get('db'), ctx.env) : null,
    ]);
    return ids
      .filter((id) => id === 'overview')
      .map((id) => ({
        id,
        tz: requestTimezone(ctx),
        trafficAvailable: true,
        ...(base
          ? {
              ...base,
              userCount: base.stats.users,
              projectCount: base.stats.projects,
              deploymentCount: base.stats.deployments,
              projects: base.projects.map((project) => projectWithUrl(project, ctx.env)),
            }
          : {}),
        ...(topProjects
          ? {
              topProjects: topProjects.map((project) => projectWithUrl(project, ctx.env)),
            }
          : {}),
      })) as Array<DashboardRecord>;
  },
});
registry.set(topProjectSource, {});
registry.set(healthSource, {
  byIds: async ({ ctx, ids }) => {
    if (!ids.includes('health')) {
      return [];
    }
    const health = await systemHealth(ctx.get('db'), ctx.env, ctx.req.url);
    return [{ id: 'health', ...health, checkedAt: Date.now() }];
  },
});

const sources = {
  getSource: <Item extends Record<string, unknown>>(
    target: { typeName: string } | SourceDefinition<Item>,
  ) => {
    const typeName = 'view' in target ? target.view.typeName : target.typeName;
    const source =
      typeName === 'AdminTopProject'
        ? topProjectSource
        : typeName === 'AdminHealth'
          ? healthSource
          : typeName === 'AdminDashboard'
            ? dashboardSource
            : (pageSourceByType.get(typeName) ?? telemetrySources.get(typeName));
    if (!source) {
      throw new Error(`Unknown admin Fate source: ${typeName}`);
    }
    return source as unknown as SourceDefinition<Item>;
  },
  registry,
};

export const Root = {
  dashboard: dashboardDataView,
  health: healthDataView,
  ...PageRoot,
  ...telemetryRoot,
};

export const fateServer = createFateServer({
  context: ({ adapterContext }: { adapterContext?: AdminContext }) => {
    if (!adapterContext) {
      throw new Error('Admin Fate requires an authenticated request context.');
    }
    return adapterContext;
  },
  queries: {
    health: {
      resolve: ({ ctx, select }: { ctx: AdminContext; select: Array<string> }) =>
        resolveSourceById({
          ctx,
          id: 'health',
          input: { select },
          registry,
          source: healthSource,
        }),
    },
    dashboard: {
      resolve: ({ ctx, select }: { ctx: AdminContext; select: Array<string> }) =>
        resolveSourceById({
          ctx,
          id: 'overview',
          input: { select },
          registry,
          source: dashboardSource,
        }),
    },
    ...pageQueries,
    ...telemetryQueries,
  },
  roots: Root,
  sources,
});

export const adminFateHandler = createHonoFateHandler(fateServer);
