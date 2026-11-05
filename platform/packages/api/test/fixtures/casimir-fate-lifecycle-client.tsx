/** @jsxImportSource react */

import { Suspense, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorsContext, NavigationContext, ParamsContext, RouterContext, SharedContext } from '@void/react';
import { createSsrRouter, idleNavigationState } from 'void/pages-client';
import { AdminProviders } from '../../src/admin/react/AdminProviders.tsx';
import { DeploymentsListPage } from '../../src/admin/react/views/DeploymentsListPage.tsx';

type TraceEvent = Record<string, string | number | boolean | null | undefined>;
type ClientTrace = {
  clientId: string;
  sessionLabel: string;
  methods: string[];
  unavailableMethods: string[];
};
type LifecycleTrace = {
  setPhase(phase: string): void;
  snapshot(): {
    format: 1;
    documentTimeOrigin: number;
    eventLimit: number;
    eventsDropped: number;
    clients: ClientTrace[];
    events: TraceEvent[];
  };
};

const maxEvents = 512;
const events: TraceEvent[] = [];
const clients: ClientTrace[] = [];
const clientIds = new WeakMap<object, string>();
const handleIds = new WeakMap<object, string>();
const suspensePromiseIds = new WeakMap<object, string>();
const descriptorIds = new Map<string, string>();
const requestKeyAliases = new Map<string, string>();
const previousHandles = new Map<string, string>();
let nextClient = 0;
let nextHandle = 0;
let nextDescriptor = 0;
let nextSession = 0;
let nextPromise = 0;
let nextEventSequence = 0;
let eventsDropped = 0;
let phase = 'initial-suspense';
const sessionLabels = new Map<string, string>();

function identity(value: unknown, seen = new WeakSet<object>(), depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') {
    return `${typeof value}:${String(value)}`;
  }
  if (typeof value === 'function') return `f:${value.name || 'anonymous'}`;
  if (depth > 8) return '[depth-limit]';
  const object = value as object;
  if (seen.has(object)) return '[cycle]';
  seen.add(object);
  const result = Array.isArray(value)
    ? `[${value.slice(0, 80).map((item) => identity(item, seen, depth + 1)).join(',')}]`
    : `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .slice(0, 80)
        .map((key) => `${JSON.stringify(key)}:${identity((value as Record<string, unknown>)[key], seen, depth + 1)}`)
        .join(',')}}`;
  seen.delete(object);
  return result;
}

function descriptorId(descriptor: unknown, mode: unknown, stage: 'raw' | 'normalized'): string {
  const signature = `${stage}|${identity(descriptor)}|${String(mode ?? '')}`;
  let id = descriptorIds.get(signature);
  if (!id) {
    id = `${stage}-key-${++nextDescriptor}`;
    descriptorIds.set(signature, id);
  }
  return id;
}

function keyIdForRequestKey(requestKey: unknown, mode: unknown): string | undefined {
  return requestKeyAliases.get(`${identity(requestKey)}|${String(mode ?? '')}`);
}

function objectId(table: WeakMap<object, string>, value: unknown, prefix: string): string | null {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const object = value as object;
  let id = table.get(object);
  if (!id) {
    id = `${prefix}-${++nextHandle}`;
    table.set(object, id);
  }
  return id;
}

function suspensePromiseId(value: unknown): string | null {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const object = value as object;
  let id = suspensePromiseIds.get(object);
  if (!id) {
    id = `promise-${++nextPromise}`;
    suspensePromiseIds.set(object, id);
  }
  return id;
}

function statusOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === 'string' ? status : null;
}

function emit(kind: string, fields: TraceEvent = {}) {
  const sequence = ++nextEventSequence;
  if (events.length >= maxEvents) {
    eventsDropped++;
    return;
  }
  events.push({ sequence, time: performance.now(), phase, kind, ...fields });
}

function installClient(clientInput: object, session: string) {
  if (clientIds.has(clientInput)) return;
  const clientId = `client-${++nextClient}`;
  clientIds.set(clientInput, clientId);
  let sessionLabel = sessionLabels.get(session);
  if (!sessionLabel) {
    sessionLabel = `session-${++nextSession}`;
    sessionLabels.set(session, sessionLabel);
  }
  const detail: ClientTrace = { clientId, sessionLabel, methods: [], unavailableMethods: [] };
  clients.push(detail);
  emit('client-created', { clientId, sessionLabel });

  const client = clientInput as Record<string, unknown>;
  const keyByHandle = new WeakMap<object, string>();
  const requiredMethods = [
    'prepareRequestForRender',
    'requestWithDescriptor',
    'executeRequestHandle',
    'retainRequestKey',
    'releaseRequestKey',
  ];
  const optionalMethods = ['hasRequestData', 'missingForSelection', 'hydrate'];

  for (const method of [...requiredMethods, ...optionalMethods]) {
    const original = client[method];
    if (typeof original !== 'function') {
      if (requiredMethods.includes(method)) detail.unavailableMethods.push(method);
      continue;
    }
    const instrumented = function (this: object, ...args: unknown[]) {
      const mode = method === 'requestWithDescriptor'
        ? args[1]
        : method === 'prepareRequestForRender'
          ? (args[1] as Record<string, unknown> | undefined)?.mode ?? 'cache-first'
          : method === 'retainRequestKey' || method === 'releaseRequestKey'
            ? args[1]
            : undefined;
      const isDescriptorMethod = method === 'requestWithDescriptor' || method === 'prepareRequestForRender';
      const key = isDescriptorMethod
        ? descriptorId(args[0], mode, method === 'prepareRequestForRender' ? 'raw' : 'normalized')
        : keyIdForRequestKey(args[0], mode);
      const handleArg = method === 'executeRequestHandle' ? args[0] : undefined;
      const handleIdBefore = handleArg ? objectId(handleIds, handleArg, 'handle') : null;
      const statusBefore = statusOf(handleArg);
      const result = Reflect.apply(original, this, args);

      if (method === 'requestWithDescriptor') {
        const handleId = objectId(handleIds, result, 'handle');
        const signature = `${clientId}|${identity(args[0])}|${String(mode ?? '')}`;
        const previous = previousHandles.get(signature);
        if (handleId) {
          previousHandles.set(signature, handleId);
          keyByHandle.set(result as object, key ?? 'unknown-key');
        }
        const options = args[2] as Record<string, unknown> | undefined;
        emit('requestWithDescriptor', {
          clientId,
          sessionLabel,
          descriptorStage: 'normalized',
          descriptorKeyId: key ?? null,
          mode: typeof mode === 'string' ? mode : null,
          handleId,
          handleAction: previous === undefined ? 'create' : previous === handleId ? 'reuse' : 'replace',
          status: statusOf(result),
          revalidateExisting: typeof options?.revalidateExisting === 'boolean' ? options.revalidateExisting : null,
        });
      } else if (method === 'prepareRequestForRender') {
        const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        if (value.requestKey !== undefined) {
          requestKeyAliases.set(`${identity(value.requestKey)}|${String(mode ?? '')}`, key ?? 'unknown-key');
        }
        emit('prepareRequestForRender', {
          clientId,
          sessionLabel,
          descriptorStage: 'raw',
          descriptorKeyId: key ?? null,
          mode: typeof mode === 'string' ? mode : null,
          requestKeyId: key ?? null,
          suspensePromiseId: suspensePromiseId(value.promise),
        });
      } else if (method === 'executeRequestHandle') {
        emit('executeRequestHandle', {
          clientId,
          sessionLabel,
          descriptorKeyId: handleArg && typeof handleArg === 'object' ? keyByHandle.get(handleArg as object) ?? null : null,
          handleId: handleIdBefore,
          statusBefore,
          statusAfter: statusOf(handleArg),
        });
      } else if (method === 'retainRequestKey') {
        emit('retainRequestKey', { clientId, sessionLabel, descriptorKeyId: key ?? null, mode: typeof mode === 'string' ? mode : null });
        if (typeof result === 'function') {
          return function (this: object, ...disposeArgs: unknown[]) {
            emit('retention-dispose', { clientId, sessionLabel, descriptorKeyId: key ?? null, mode: typeof mode === 'string' ? mode : null });
            return Reflect.apply(result, this, disposeArgs);
          };
        }
      } else if (method === 'releaseRequestKey') {
        emit('releaseRequestKey', { clientId, sessionLabel, descriptorKeyId: key ?? null, mode: typeof mode === 'string' ? mode : null });
      } else if (method === 'hasRequestData') {
        emit('hasRequestData', { clientId, sessionLabel, result: typeof result === 'boolean' ? result : null });
      } else if (method === 'missingForSelection') {
        emit('missingForSelection', {
          clientId,
          sessionLabel,
          missingCount: Array.isArray(result) ? result.length : null,
        });
      } else if (method === 'hydrate') {
        emit('hydrate', { clientId, sessionLabel });
      }
      return result;
    };
    if (!Reflect.set(client, method, instrumented) || client[method] !== instrumented) {
      if (requiredMethods.includes(method)) detail.unavailableMethods.push(method);
      emit('instrumentation-method-wrap-failed', { clientId, sessionLabel, method });
      continue;
    }
    detail.methods.push(method);
  }
  if (detail.unavailableMethods.length) {
    emit('instrumentation-methods-missing', {
      clientId,
      unavailable: detail.unavailableMethods.join(','),
    });
  }
}

const lifecycleWindow = window as Window & {
  __CASIMIR_FATE_LIFECYCLE_INSTALL__?: (client: object, session: string) => void;
  __CASIMIR_FATE_LIFECYCLE_TRACE__?: LifecycleTrace;
};

lifecycleWindow.__CASIMIR_FATE_LIFECYCLE_INSTALL__ = installClient;
lifecycleWindow.__CASIMIR_FATE_LIFECYCLE_TRACE__ = {
  setPhase(nextPhase) {
    phase = nextPhase;
    emit('phase-marker', { nextPhase });
  },
  snapshot() {
    return {
      format: 1,
      documentTimeOrigin: performance.timeOrigin,
      eventLimit: maxEvents,
      eventsDropped,
      clients: clients.map((client) => ({ ...client, methods: [...client.methods], unavailableMethods: [...client.unavailableMethods] })),
      events: events.map((event) => ({ ...event })),
    };
  },
};

function LifecycleHarness() {
  const [revision, setRevision] = useState(0);
  const router = useMemo(() => createSsrRouter('/admin/deployments'), []);
  const navigation = useMemo(() => idleNavigationState(), []);
  const shared = useMemo(
    () => ({ platformName: 'Casimir lifecycle fixture', adminFateSession: 'fixture-session-a', adminPageUrl: '/admin/deployments' }),
    [],
  );

  return (
    <main>
      <div data-testid="lifecycle-controls">
        <button data-testid="force-rerender" onClick={() => setRevision((value) => value + 1)}>
          Force rerender
        </button>
        <output data-testid="lifecycle-revision">{revision}</output>
      </div>
      <RouterContext.Provider value={router}>
        <NavigationContext.Provider value={navigation}>
          <Suspense fallback={<div data-testid="suspense-fallback">Waiting for Fate response</div>}>
            <RouterContext.Provider value={router}>
              <ParamsContext.Provider value={{}}>
                <SharedContext.Provider value={shared}>
                  <ErrorsContext.Provider value={{}}>
                    <AdminProviders>
                      <DeploymentsListPage
                        path="/admin/deployments"
                        platformName="Casimir lifecycle fixture"
                        username="operator"
                      />
                    </AdminProviders>
                  </ErrorsContext.Provider>
                </SharedContext.Provider>
              </ParamsContext.Provider>
            </RouterContext.Provider>
          </Suspense>
        </NavigationContext.Provider>
      </RouterContext.Provider>
    </main>
  );
}

const rootElement = document.getElementById('app');
if (!rootElement) throw new Error('lifecycle_fixture_missing_app_root');
createRoot(rootElement).render(<LifecycleHarness />);
