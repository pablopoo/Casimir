import { getPlatformCapabilities } from '../capabilities.ts';
import {
  getAllDeploymentsWithProject,
  getAllProjectsWithOwner,
  getSystemStats,
  type Db,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { SITE_DOMAIN } from '../constants.ts';

/** Database-backed dashboard data that is independent of the hosting provider. */
export async function systemOverviewBase(
  db: Db,
  env: Pick<
    ApiEnv['Bindings'],
    'PLATFORM_CAPABILITIES' | 'PLATFORM_INSTALLATION_ID' | 'PLATFORM_VERSION' | 'SITE_DOMAIN'
  >,
) {
  const [stats, projects, deployments] = await Promise.all([
    getSystemStats(db),
    getAllProjectsWithOwner(db, 5, 0),
    getAllDeploymentsWithProject(db, 5, 0),
  ]);
  return {
    stats,
    projects,
    deployments,
    siteDomain: env.SITE_DOMAIN ?? SITE_DOMAIN,
    capabilities: getPlatformCapabilities(env),
    installationId: env.PLATFORM_INSTALLATION_ID ?? null,
    version: env.PLATFORM_VERSION ?? null,
  };
}

export type SystemOverviewBase = Awaited<ReturnType<typeof systemOverviewBase>>;
