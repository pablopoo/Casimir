import { dataView, type Entity } from '@nkzw/fate/server';
import type { Context } from 'hono';
import { parseCasimirManifest, type CasimirManifest } from '@void/deploy-core';
import { getDeployment } from '../../db/deployments.ts';
import { getProject } from '../../db/projects.ts';
import type { PlatformManagementEnv } from '../../env.ts';
import { OperatorError } from '../../operator/common.ts';
import type { DeployManifest } from '../../types.ts';
import { detailLocation, requestTimezone } from './page-requests.ts';

export type DeploymentManifest = DeployManifest | CasimirManifest;

export function parseDeploymentManifest(source: string | null, raw: string): DeploymentManifest {
  const value: unknown = JSON.parse(raw);
  return source === 'casimir-artifact'
    ? parseCasimirManifest(value)
    : (value as DeployManifest);
}

export async function loadDeploymentDetailPage<E extends PlatformManagementEnv>(
  context: Context<E>,
  path: string,
) {
  const { id } = detailLocation(path, '/admin/deployments/');
  const deployment = await getDeployment(context.get('db'), id);
  if (!deployment) {
    throw new OperatorError(404, 'Deployment not found');
  }
  const project = await getProject(context.get('db'), deployment.project_id);
  let manifest: DeploymentManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = parseDeploymentManifest(deployment.source, deployment.manifest);
    }
  } catch {
    // Preserve the detail page when an old manifest is malformed or a Casimir manifest is invalid.
  }
  return {
    id: path,
    deployment,
    project,
    manifest,
    canCancel: ['pending', 'uploading', 'migrating', 'prerendering'].includes(deployment.status),
    tz: requestTimezone(context),
  };
}

export type DeploymentDetailRecord = Awaited<ReturnType<typeof loadDeploymentDetailPage>>;

export const deploymentDetailDataView = dataView<DeploymentDetailRecord>('AdminDeploymentDetail')({
  id: true,
  deployment: true,
  project: true,
  manifest: true,
  canCancel: true,
  tz: true,
});

export type AdminDeploymentDetail = Entity<typeof deploymentDetailDataView, 'AdminDeploymentDetail'>;
