/** @jsxImportSource react */
import { Button } from '@astryxdesign/core/Button';
import { useRouter } from '@void/react';
import { useCallback } from 'react';
import { useFateClient } from 'react-fate';
import type { Deployment, User } from '../../../types.ts';
import {
  DeploymentsPageView,
  deploymentsPageRequest,
  ProjectsPageView,
  projectsPageRequest,
  UsersPageView,
  usersPageRequest,
} from '../../fate/views.ts';
import { SearchTypeahead, type SearchSuggestion } from './SearchTypeahead.tsx';

export function SearchForm({
  action,
  kind,
  label,
  value,
  onChange,
  initialValue,
  initialSelection,
}: {
  action: string;
  kind: 'users' | 'projects' | 'deployments';
  label: string;
  value: string;
  onChange: (value: string) => void;
  initialValue?: string;
  initialSelection?: SearchSuggestion;
}) {
  const fate = useFateClient();
  const router = useRouter();
  const remoteSearch = useCallback(
    async (query: string): Promise<ReadonlyArray<SearchSuggestion>> => {
      const path = `${action}?search=${encodeURIComponent(query)}`;
      if (kind === 'users') {
        const { usersPage: ref } = await fate.request(usersPageRequest(path), {
          mode: 'network-only',
        });
        if (!ref) {
          return [];
        }
        const { data } = (await fate.readView(UsersPageView, ref)) as unknown as {
          data: { users: Array<Pick<User, 'id' | 'login' | 'email'>> };
        };
        return data.users.map((user) => ({
          id: user.id,
          label: user.login,
          description: [user.email, user.id].filter(Boolean).join(' · '),
        }));
      }
      if (kind === 'projects') {
        const { projectsPage: ref } = await fate.request(projectsPageRequest(path), {
          mode: 'network-only',
        });
        if (!ref) {
          return [];
        }
        const { data } = (await fate.readView(ProjectsPageView, ref)) as unknown as {
          data: { projects: Array<{ id: string; slug: string; owner_login: string | null }> };
        };
        return data.projects.map((project) => ({
          id: project.id,
          label: project.slug,
          description: project.owner_login ?? undefined,
        }));
      }
      const { deploymentsPage: ref } = await fate.request(deploymentsPageRequest(path), {
        mode: 'network-only',
      });
      if (!ref) {
        return [];
      }
      const { data } = (await fate.readView(DeploymentsPageView, ref)) as unknown as {
        data: {
          deployments: Array<Pick<Deployment, 'id' | 'status'> & { project_slug: string | null }>;
        };
      };
      return data.deployments.map((deployment) => ({
        id: deployment.id,
        label: deployment.id,
        description: [deployment.project_slug, deployment.status].filter(Boolean).join(' · '),
      }));
    },
    [action, fate, kind],
  );

  return (
    <form method="get" action={action} className="void-admin-search">
      <input type="hidden" name="search" value={value} />
      <SearchTypeahead
        key={initialValue ?? ''}
        label={label}
        onChange={onChange}
        onSelect={(id) => void router.visit(`${action}/${encodeURIComponent(id)}`)}
        onClear={() => {
          if (initialValue) {
            void router.visit(action);
          }
        }}
        remoteSearch={remoteSearch}
        initialValue={initialValue}
        initialSelection={initialSelection}
      />
      <Button type="submit" label="Search" />
    </form>
  );
}
