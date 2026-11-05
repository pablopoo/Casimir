import { dataView, list, type Entity } from '@nkzw/fate/server';
import type { HealthResult } from '../../operator/system-health-contract.ts';
import type { SystemOverviewBase } from '../../operator/system-overview.ts';

export type TopProjectRecord = Readonly<{
  id: string;
  user_id: string;
  slug: string;
  type: string;
  owner_login: string | null;
  requests: number;
  bandwidthBytes: number;
  lastSeen: string;
  url?: string | null;
}>;

export type DashboardRecord = SystemOverviewBase & {
  id: string;
  userCount: number;
  projectCount: number;
  deploymentCount: number;
  tz: string | undefined;
  trafficAvailable: boolean;
  topProjects?: Array<TopProjectRecord>;
};

export type HealthRecord = HealthResult & { id: string; checkedAt: number };

export const healthDataView = dataView<HealthRecord>('AdminHealth')({
  id: true,
  allOk: true,
  checks: true,
  checkedAt: true,
});

export const topProjectDataView = dataView<TopProjectRecord>('AdminTopProject')({
  id: true,
  user_id: true,
  slug: true,
  type: true,
  owner_login: true,
  requests: true,
  bandwidthBytes: true,
  lastSeen: true,
  url: true,
});

export const dashboardDataView = dataView<DashboardRecord>('AdminDashboard')({
  id: true,
  userCount: true,
  projectCount: true,
  deploymentCount: true,
  projects: true,
  deployments: true,
  siteDomain: true,
  tz: true,
  trafficAvailable: true,
  topProjects: list(topProjectDataView),
});

export type AdminTopProject = Entity<typeof topProjectDataView, 'AdminTopProject'>;
export type AdminHealth = Entity<typeof healthDataView, 'AdminHealth'>;
export type AdminDashboard = Entity<
  typeof dashboardDataView,
  'AdminDashboard',
  { topProjects: Array<AdminTopProject> }
>;
