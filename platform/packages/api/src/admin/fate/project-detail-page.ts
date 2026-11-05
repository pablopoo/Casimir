import { dataView, type Entity } from '@nkzw/fate/server';
import type { Context } from 'hono';
import { getPendingProjectInvitations, getProjectMembers } from '../../db/projects.ts';
import type { Db } from '../../db/client.ts';
import type { PlatformManagementEnv } from '../../env.ts';
import type { Project } from '../../types.ts';
import { getOperatorProject } from '../../operator/tenant-read-service.ts';
import { projectUrl } from '../../project-url.ts';
import { detailLocation, requestTimezone } from './page-requests.ts';

export type ProjectDetailUrlResolver = (project: Project) => string | null;

export type ProjectDetailPageOptions = Readonly<{
  cfAccountId?: string;
  resolveProjectUrl?: ProjectDetailUrlResolver;
}>;

async function loadProjectZeroTrust(db: Db, projectId: string) {
  const {
    ZeroTrustConfigurationError,
    readZeroTrustConfigurationStrict,
    zeroTrustConfigurationStatus,
  } = await import('../../zero-trust/configuration.ts');
  const { getProjectZeroTrustState, projectZeroTrustAvailable, publicProjectZeroTrustState } =
    await import('../../zero-trust/state.ts');
  const [row, configuration] = await Promise.all([
    getProjectZeroTrustState(db, projectId),
    readZeroTrustConfigurationStrict(db).catch((error: unknown) => {
      if (error instanceof ZeroTrustConfigurationError) {
        return 'invalid' as const;
      }
      throw error;
    }),
  ]);
  const saved = configuration === 'invalid' ? null : configuration;
  return {
    configured: configuration !== null,
    invalid: configuration === 'invalid',
    enabled: saved?.enabled ?? false,
    status: saved ? zeroTrustConfigurationStatus(saved) : null,
    operation: saved?.operation?.kind ?? null,
    available: projectZeroTrustAvailable(saved),
    state: publicProjectZeroTrustState(row),
  };
}

export async function loadProjectDetailPage<E extends PlatformManagementEnv>(
  context: Context<E>,
  path: string,
  options: ProjectDetailPageOptions = {},
) {
  const { id } = detailLocation(path, '/admin/projects/');
  const db = context.get('db');
  const [detail, members, invitations, zeroTrust] = await Promise.all([
    getOperatorProject(db, id),
    getProjectMembers(db, id),
    getPendingProjectInvitations(db, id),
    loadProjectZeroTrust(db, id),
  ]);
  return {
    id: path,
    ...detail,
    teamMembers: members.map(({ member, user }) => ({
      user: { id: user.id, login: user.login, email: user.email },
      role: member.role,
      createdAt: member.created_at,
    })),
    pendingTeamInvitations: invitations.map((invitation) => ({
      id: invitation.id,
      targetUserId: invitation.target_user_id,
      email: invitation.target_email_snapshot,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    })),
    zeroTrust,
    cfAccountId: options.cfAccountId,
    deployUrl: options.resolveProjectUrl
      ? options.resolveProjectUrl(detail.project)
      : projectUrl(detail.project, context.env),
    tz: requestTimezone(context),
  };
}

export type ProjectDetailRecord = Awaited<ReturnType<typeof loadProjectDetailPage>>;

export const projectDetailDataView = dataView<ProjectDetailRecord>('AdminProjectDetail')({
  id: true,
  project: true,
  deployments: true,
  resources: true,
  owner: true,
  teamMembers: true,
  pendingTeamInvitations: true,
  domains: true,
  builds: true,
  zeroTrust: true,
  cfAccountId: true,
  deployUrl: true,
  tz: true,
});

export type AdminProjectDetail = Entity<typeof projectDetailDataView, 'AdminProjectDetail'>;
