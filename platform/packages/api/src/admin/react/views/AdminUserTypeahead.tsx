/** @jsxImportSource react */

import {
  Typeahead,
  TypeaheadItem,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import { useMemo } from 'react';
import { useFateClient } from 'react-fate';
import type { User } from '../../../types.ts';
import { UsersPageView, usersPageRequest } from '../../fate/views.ts';

export type AdminUserSuggestion = SearchableItem<{ email: string | null }>;

const noExcludedUsers: ReadonlySet<string> = new Set();

export function AdminUserTypeahead({
  label,
  selected,
  onChange,
  excludedUserIds = noExcludedUsers,
}: {
  label: string;
  selected: AdminUserSuggestion | null;
  onChange: (user: AdminUserSuggestion | null) => void;
  excludedUserIds?: ReadonlySet<string>;
}) {
  const fate = useFateClient();
  const source = useMemo<SearchSource<AdminUserSuggestion>>(
    () => ({
      bootstrap: () => [],
      search: async (query: string) => {
        const { usersPage: ref } = await fate.request(
          usersPageRequest(`/admin/users?search=${encodeURIComponent(query)}`),
          { mode: 'network-only' },
        );
        if (!ref) {
          return [];
        }
        const { data } = (await fate.readView(UsersPageView, ref)) as unknown as {
          data: { users: Array<User> };
        };
        return data.users
          .filter((user) => !excludedUserIds.has(user.id))
          .map((user) => ({
            id: user.id,
            label: user.login,
            auxiliaryData: { email: user.email },
          }));
      },
    }),
    [fate, excludedUserIds],
  );

  return (
    <Typeahead
      label={label}
      placeholder="Search by login, email, or ID"
      searchSource={source}
      value={selected}
      onChange={onChange}
      onChangeQuery={() => onChange(null)}
      renderItem={(item: AdminUserSuggestion) => (
        <TypeaheadItem
          item={item}
          description={[item.auxiliaryData?.email, item.id].filter(Boolean).join(' · ')}
        />
      )}
      minQueryLength={2}
      width="min(100%, 320px)"
      emptySearchText="No eligible users found."
    />
  );
}
