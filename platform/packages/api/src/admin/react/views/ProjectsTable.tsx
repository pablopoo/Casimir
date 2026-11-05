/** @jsxImportSource @voidcloud/api/admin-jsx */
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { Project } from '../../../types.ts';
import { formatDateTime } from './format.ts';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';

export type ProjectRow = Project & {
  url?: string | null;
  owner_login: string | null;
  last_deploy: string | null;
  last_deploy_id: string | null;
  last_deploy_status: string | null;
};

export function ProjectsTable({
  projects,
  siteDomain,
  tz,
}: {
  projects: ReadonlyArray<ProjectRow>;
  siteDomain: string;
  tz?: string;
}) {
  return (
    <>
      <Table className="void-admin-projects-table" hasHover>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>URL</TableHeaderCell>
            <TableHeaderCell>Owner</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableHeaderCell>Last Deploy</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <a className="void-admin-resource-link" href={`/admin/projects/${p.id}`}>
                  {p.slug}
                </a>
              </TableCell>
              <TableCell>
                {p.url === null ? (
                  <span>Unavailable</span>
                ) : (
                  <ProjectUrlLink url={p.url ?? `https://${p.slug}.${siteDomain}`} />
                )}
              </TableCell>
              <TableCell>
                {p.owner_login ? (
                  <a className="void-admin-resource-link" href={`/admin/users/${p.user_id}`}>
                    {p.owner_login}
                  </a>
                ) : (
                  '-'
                )}
              </TableCell>
              <TableCell>{p.type}</TableCell>
              <TableCell>{formatDateTime(p.created_at, tz)}</TableCell>
              <TableCell>
                {p.last_deploy ? (
                  <>
                    <span
                      style={`display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:10px;vertical-align:middle;background:${p.last_deploy_status === 'failed' ? '#dc2626' : '#16a34a'}`}
                    />
                    {p.last_deploy_id ? (
                      <a href={`/admin/deployments/${p.last_deploy_id}`}>
                        {formatDateTime(p.last_deploy, tz)}
                      </a>
                    ) : (
                      formatDateTime(p.last_deploy, tz)
                    )}
                  </>
                ) : (
                  '-'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {projects.length === 0 && (
        <p>
          <em>No projects found.</em>
        </p>
      )}
    </>
  );
}
