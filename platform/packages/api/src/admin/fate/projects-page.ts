import { dataView, type Entity } from '@nkzw/fate/server';
import type { Context } from 'hono';
import { SITE_DOMAIN } from '../../constants.ts';
import { countProjects, getAllProjectsWithOwner, searchProjects } from '../../db.ts';
import type { PlatformManagementEnv } from '../../env.ts';
import { projectWithUrl } from '../../project-url.ts';
import { ADMIN_PAGE_SIZE, pageLocation, pageNumber, requestTimezone } from './page-requests.ts';

export type ProjectPageUrlResolver = (project: Parameters<typeof projectWithUrl>[0]) => string | null;

export function projectWithPageUrl<
  E extends PlatformManagementEnv,
  Project extends Parameters<typeof projectWithUrl>[0],
>(
  context: Context<E>,
  project: Project,
  resolveProjectUrl?: ProjectPageUrlResolver,
): Project & { url?: string | null } {
  if (resolveProjectUrl) {
    return { ...project, url: resolveProjectUrl(project) };
  }
  return projectWithUrl(project, context.env);
}

export async function loadProjectsPage<E extends PlatformManagementEnv>(
  context: Context<E>,
  path: string,
  resolveProjectUrl?: ProjectPageUrlResolver,
) {
  const url = pageLocation(path, '/admin/projects');
  const search = url.searchParams.get('search') ?? undefined;
  const siteDomain = context.env.SITE_DOMAIN ?? SITE_DOMAIN;
  const tz = requestTimezone(context);
  if (search) {
    const projects = await searchProjects(context.get('db'), search);
    return {
      id: path,
      projects: projects.map((project) => projectWithPageUrl(context, project, resolveProjectUrl)),
      search,
      siteDomain,
      tz,
    };
  }
  const page = pageNumber(url);
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(context.get('db'), ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE),
    countProjects(context.get('db')),
  ]);
  return {
    id: path,
    projects: projects.map((project) => projectWithPageUrl(context, project, resolveProjectUrl)),
    page,
    totalPages: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)),
    siteDomain,
    tz,
  };
}

export type ProjectsPageRecord = Awaited<ReturnType<typeof loadProjectsPage>>;

export const projectsPageDataView = dataView<ProjectsPageRecord>('AdminProjectsPage')({
  id: true,
  projects: true,
  search: true,
  page: true,
  totalPages: true,
  siteDomain: true,
  tz: true,
});

export type AdminProjectsPage = Entity<typeof projectsPageDataView, 'AdminProjectsPage'>;
