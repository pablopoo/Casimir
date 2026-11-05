import { expect, it } from 'vite-plus/test';
import { createAdminFateClientScope } from '../../src/admin/react/admin-fate-client-scope.ts';

type FakeFateClient = {
  id: number;
  cache: string[];
};

it('reuses one browser client for the exact session and hydrates it only on creation', () => {
  const scope = createAdminFateClientScope<FakeFateClient, string>();
  const hydrated: string[] = [];
  let created = 0;
  const get = (snapshot: string) =>
    scope.get({
      environment: 'browser',
      sessionKey: 'user-a:session-a',
      snapshot,
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: (client, value) => {
        hydrated.push(value);
        client.cache.push(value);
      },
    });

  const first = get('server-snapshot-a');
  const retry = get('server-snapshot-b');

  expect(retry).toBe(first);
  expect(created).toBe(1);
  expect(hydrated).toEqual(['server-snapshot-a']);
  expect(first.cache).toEqual(['server-snapshot-a']);
});

it('keeps the published browser client when replacement creation or hydration fails', () => {
  const scope = createAdminFateClientScope<FakeFateClient, string>();
  let created = 0;
  const first = scope.get({
    environment: 'browser',
    sessionKey: 'user-a:session-a',
    snapshot: 'snapshot-a',
    createClient: () => ({ id: ++created, cache: [] }),
    hydrate: (client, value) => client.cache.push(value),
  });

  expect(() =>
    scope.get({
      environment: 'browser',
      sessionKey: 'user-b:session-b',
      snapshot: 'snapshot-b',
      createClient: () => {
        throw new Error('create failed');
      },
      hydrate: (client, value) => client.cache.push(value),
    }),
  ).toThrow('create failed');
  expect(
    scope.get({
      environment: 'browser',
      sessionKey: 'user-a:session-a',
      snapshot: 'snapshot-a-retry',
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: (client, value) => client.cache.push(value),
    }),
  ).toBe(first);

  expect(() =>
    scope.get({
      environment: 'browser',
      sessionKey: 'user-b:session-b',
      snapshot: 'snapshot-b',
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: () => {
        throw new Error('hydrate failed');
      },
    }),
  ).toThrow('hydrate failed');
  expect(
    scope.get({
      environment: 'browser',
      sessionKey: 'user-a:session-a',
      snapshot: 'snapshot-a-retry-again',
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: (client, value) => client.cache.push(value),
    }),
  ).toBe(first);
});

it('keeps A, B, stale A, then B clients and hydrated data isolated by exact key', () => {
  const scope = createAdminFateClientScope<FakeFateClient, string>();
  let created = 0;
  const get = (sessionKey: string, snapshot: string) =>
    scope.get({
      environment: 'browser',
      sessionKey,
      snapshot,
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: (client, value) => client.cache.push(value),
    });

  const firstA = get('user-a:session-a', 'A-first');
  const firstB = get('user-b:session-b', 'B-first');
  const staleA = get('user-a:session-a', 'A-stale');
  const secondB = get('user-b:session-b', 'B-second');

  expect(staleA).not.toBe(firstA);
  expect(secondB).not.toBe(firstB);
  expect(firstA.cache).toEqual(['A-first']);
  expect(firstB.cache).toEqual(['B-first']);
  expect(staleA.cache).toEqual(['A-stale']);
  expect(secondB.cache).toEqual(['B-second']);
});

it('creates independent request-local server clients without changing the browser slot', () => {
  const scope = createAdminFateClientScope<FakeFateClient, string>();
  let created = 0;
  const get = (environment: 'browser' | 'server', snapshot: string) =>
    scope.get({
      environment,
      sessionKey: 'user-a:session-a',
      snapshot,
      createClient: () => ({ id: ++created, cache: [] }),
      hydrate: (client, value) => client.cache.push(value),
    });

  const browser = get('browser', 'browser-snapshot');
  const serverRequestA = get('server', 'request-a-snapshot');
  const serverRequestB = get('server', 'request-b-snapshot');
  const browserRetry = get('browser', 'later-browser-snapshot');

  expect(serverRequestB).not.toBe(serverRequestA);
  expect(serverRequestA).not.toBe(browser);
  expect(serverRequestB).not.toBe(browser);
  expect(browserRetry).toBe(browser);
  expect(browser.cache).toEqual(['browser-snapshot']);
  expect(serverRequestA.cache).toEqual(['request-a-snapshot']);
  expect(serverRequestB.cache).toEqual(['request-b-snapshot']);
});
