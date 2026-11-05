/** @jsxImportSource @voidcloud/api/admin-jsx */

import { LayerProvider } from '@astryxdesign/core/Layer';
import { LinkProvider } from '@astryxdesign/core/Link';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Link, useShared } from '@void/react';
import type { ReactNode } from 'react';
import { FateClient } from 'react-fate';
import { createFateClient } from '../fate/client.generated.ts';
import { AdminFateErrorBoundary } from './AdminFateErrorBoundary.tsx';
import { createAdminFateClientScope } from './admin-fate-client-scope.ts';

type AdminFateClient = ReturnType<typeof createFateClient>;
type AdminFateSnapshot = Parameters<AdminFateClient['hydrate']>[0];

const adminFateClientScope = createAdminFateClientScope<AdminFateClient, AdminFateSnapshot>();

type AdminShared = {
  platformName?: string;
  adminFateSession?: string;
  adminFateSnapshot?: AdminFateSnapshot;
  adminPageUrl?: string;
};

/** Appearance and navigation work in both a page and its Suspense fallback. */
export function AdminUiProviders({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme}>
      <div className="void-admin-toast-provider">
        <LayerProvider toast={{ position: 'topEnd', maxVisible: 3 }}>
          <LinkProvider component={Link}>{children}</LinkProvider>
        </LayerProvider>
      </div>
    </Theme>
  );
}

export function AdminProviders({ children }: { children: ReactNode }) {
  const shared = useShared<AdminShared>();
  const session = shared.adminFateSession ?? 'guest';
  const fate = adminFateClientScope.get({
    environment: typeof window === 'undefined' ? 'server' : 'browser',
    sessionKey: session,
    snapshot: shared.adminFateSnapshot,
    createClient: () => {
      const client = createFateClient({
        url: typeof window === 'undefined' ? 'http://localhost/admin/fate' : '/admin/fate',
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            credentials: 'same-origin',
          }).then((response) => {
            if (response.redirected && new URL(response.url).pathname === '/admin/login') {
              window.location.assign('/admin/login');
              throw new Error('Administrator session expired.');
            }
            return response;
          }),
      });
      return client;
    },
    hydrate: (client, snapshot) => client.hydrate(snapshot),
  });
  return (
    <AdminUiProviders>
      <FateClient client={fate} key={session}>
        <AdminFateErrorBoundary
          key={shared.adminPageUrl}
          platformName={shared.platformName ?? 'Void Platform'}
        >
          {children}
        </AdminFateErrorBoundary>
      </FateClient>
    </AdminUiProviders>
  );
}
