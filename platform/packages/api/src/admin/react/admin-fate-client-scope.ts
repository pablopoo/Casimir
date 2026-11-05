export type AdminFateClientEnvironment = 'browser' | 'server';

export type AdminFateClientScopeOptions<TClient, TSnapshot> = {
  environment: AdminFateClientEnvironment;
  sessionKey: string;
  snapshot: TSnapshot | undefined;
  createClient: () => TClient;
  hydrate: (client: TClient, snapshot: TSnapshot) => void;
};

/** Keeps browser client ownership stable across pre-commit Suspense retries. */
export function createAdminFateClientScope<TClient, TSnapshot>() {
  let browserEntry: { sessionKey: string; client: TClient } | undefined;

  return {
    get(options: AdminFateClientScopeOptions<TClient, TSnapshot>): TClient {
      const createHydratedClient = () => {
        const client = options.createClient();
        if (options.snapshot !== undefined) {
          options.hydrate(client, options.snapshot);
        }
        return client;
      };

      if (options.environment === 'server') {
        return createHydratedClient();
      }

      if (browserEntry?.sessionKey === options.sessionKey) {
        return browserEntry.client;
      }

      const client = createHydratedClient();
      browserEntry = { sessionKey: options.sessionKey, client };
      return client;
    },
  };
}
