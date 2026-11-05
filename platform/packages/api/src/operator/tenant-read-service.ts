import { getProjectDeployments } from '../db/deployments.ts';
import { getProjectBuilds } from '../db/builds.ts';
import { getDomainsByProjectId } from '../db/domains.ts';
import { type Db } from '../db/client.ts';
import { getProjectResources } from '../db/resources.ts';
import { getProject } from '../db/projects.ts';
import { getUser } from '../db/users.ts';
import { OperatorError } from './common.ts';

async function requireProject(db: Db, id: string) {
  const project = await getProject(db, id);
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }
  return project;
}

/** Database-only detail assembly shared by the original admin UI and host adapters. */
export async function getOperatorProject(db: Db, id: string) {
  const project = await requireProject(db, id);
  const [deployments, resources, owner, domains, builds] = await Promise.all([
    getProjectDeployments(db, id, 10),
    getProjectResources(db, id),
    getUser(db, project.user_id),
    getDomainsByProjectId(db, id),
    getProjectBuilds(db, id),
  ]);
  return { project, deployments, resources, owner, domains, builds };
}
