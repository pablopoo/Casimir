import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createFateFetchHandler,
  createFateServer,
  resolveSourceById,
  type SourceDefinition,
  type SourceRegistry,
} from '@nkzw/fate/server';
import { expect, it } from 'vite-plus/test';
import { createFateClient } from '../../src/admin/fate/client.generated.ts';
import {
  deploymentsPageDataView,
  type DeploymentsPageRecord,
} from '../../src/admin/fate/deployments-page.ts';
import { deploymentsPageRequest } from '../../src/admin/fate/views.ts';

type CacheFixtureContext = Record<never, never>;
type TimezoneMode = 'absent' | 'UTC';

type CapturedOperation = {
  args?: { path?: string };
  kind?: string;
  name?: string;
  select?: Array<string>;
};

type CapturedExchange = {
  operations: Array<CapturedOperation>;
  resultSummaries: Array<{
    ok: boolean;
    selectedPaths: Array<string>;
    presentFields: Array<string>;
    missingFields: Array<string>;
    responseShape: Array<string>;
  }>;
  status: number;
};

type CacheScenarioResult = {
  timezoneMode: TimezoneMode;
  fixtureScope: 'synthetic Fate JSON/cache protocol only';
  exchanges: Array<CapturedExchange>;
  afterWarmTransportCount: number;
  afterEquivalentCacheFirstTransportCount: number;
  equivalentRequestTransportDelta: number;
};

const pagePath = '/admin/deployments';
const resultPath = process.env.CASIMIR_FATE_CACHE_RESULT_PATH;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findRecord(value: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecord(item, id);
      if (found) return found;
    }
    return undefined;
  }
  const record = objectRecord(value);
  if (!record) return undefined;
  if (record.id === id) return record;
  for (const nested of Object.values(record)) {
    const found = findRecord(nested, id);
    if (found) return found;
  }
  return undefined;
}

function collectResponseShape(value: unknown, prefix = '$'): Array<string> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectResponseShape(item, `${prefix}[${index}]`));
  }
  const record = objectRecord(value);
  if (!record) return [prefix];
  const entries = Object.entries(record);
  if (entries.length === 0) return [`${prefix}{}`];
  return entries.flatMap(([key, nested]) => collectResponseShape(nested, `${prefix}.${key}`));
}

function operationSummaries(value: unknown): Array<CapturedOperation> {
  const body = objectRecord(value);
  return Array.isArray(body?.operations)
    ? body.operations.map((operation) => {
        const item = objectRecord(operation) ?? {};
        const args = objectRecord(item.args);
        return {
          kind: typeof item.kind === 'string' ? item.kind : undefined,
          name: typeof item.name === 'string' ? item.name : undefined,
          args: typeof args?.path === 'string' ? { path: args.path } : undefined,
          select: Array.isArray(item.select)
            ? item.select.filter((path): path is string => typeof path === 'string').sort()
            : [],
        };
      })
    : [];
}

function selectedRootFields(operations: Array<CapturedOperation>): Array<string> {
  return [...new Set(operations.flatMap((operation) => operation.select ?? []).map((path) => path.split('.')[0]!))].sort();
}

function responseResultSummaries(
  value: unknown,
  operations: Array<CapturedOperation>,
): CapturedExchange['resultSummaries'] {
  const body = objectRecord(value);
  const results = Array.isArray(body?.results) ? body.results : [];
  const selectedPaths = [...new Set(operations.flatMap((operation) => operation.select ?? []))].sort();
  const selectedFields = selectedRootFields(operations);
  return results.map((result) => {
    const item = objectRecord(result) ?? {};
    const data = item.data;
    const pageRecord = findRecord(data, pagePath);
    const presentFields = pageRecord ? Object.keys(pageRecord).sort() : [];
    return {
      ok: item.ok === true,
      selectedPaths,
      presentFields,
      missingFields: selectedFields.filter((field) => !presentFields.includes(field)),
      responseShape: collectResponseShape(data).slice(0, 48).sort(),
    };
  });
}

async function runScenario(timezoneMode: TimezoneMode): Promise<CacheScenarioResult> {
  const recordFor = (id: string): DeploymentsPageRecord =>
    ({
      id,
      deployments: [],
      page: 1,
      totalPages: 1,
      ...(timezoneMode === 'UTC' ? { tz: 'UTC' } : {}),
    }) as unknown as DeploymentsPageRecord;

  const source: SourceDefinition<DeploymentsPageRecord> = {
    id: 'id',
    view: deploymentsPageDataView,
  };
  const registry: SourceRegistry<CacheFixtureContext> = new Map([
    [
      source,
      {
        byIds: async ({ ids }) => ids.map(recordFor),
      },
    ],
  ]);
  const fateServer = createFateServer({
    context: () => ({}),
    queries: {
      deploymentsPage: {
        resolve: ({
          ctx,
          input,
          select,
        }: {
          ctx: CacheFixtureContext;
          input: { args?: Record<string, unknown> };
          select: Array<string>;
        }) => {
          const id = input.args?.path;
          if (typeof id !== 'string') throw new Error('Missing deployment page path.');
          return resolveSourceById({
            ctx,
            id,
            input: { select },
            registry,
            source,
          });
        },
      },
    },
    roots: { deploymentsPage: deploymentsPageDataView },
    sources: {
      // The registry API widens its source map keys to AnyRecord, while this
      // fixture keeps the concrete record type for resolveSourceById.
      getSource: () => source as SourceDefinition,
      registry,
    },
  });
  const handleFateRequest = createFateFetchHandler(fateServer);
  const result: CacheScenarioResult = {
    timezoneMode,
    fixtureScope: 'synthetic Fate JSON/cache protocol only',
    exchanges: [],
    afterWarmTransportCount: 0,
    afterEquivalentCacheFirstTransportCount: 0,
    equivalentRequestTransportDelta: 0,
  };
  const client = createFateClient({
    url: 'https://admin.example.test/admin/fate',
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const requestBody = await request.clone().json();
      const operations = operationSummaries(requestBody);
      const response = await handleFateRequest(request, {});
      const responseBody = await response.clone().json();
      result.exchanges.push({
        operations,
        resultSummaries: responseResultSummaries(responseBody, operations),
        status: response.status,
      });
      return response;
    },
  });

  await client.request(deploymentsPageRequest(pagePath));
  result.afterWarmTransportCount = result.exchanges.length;
  await client.request(deploymentsPageRequest(pagePath), { mode: 'cache-first' });
  result.afterEquivalentCacheFirstTransportCount = result.exchanges.length;
  result.equivalentRequestTransportDelta =
    result.afterEquivalentCacheFirstTransportCount - result.afterWarmTransportCount;
  return result;
}

it('records Fate cache completeness for the original deploymentsPage descriptor roundtrip', async () => {
  const artifact: {
    description: string;
    protocol: 'installed @nkzw/fate + original API descriptor/client';
    scenarios: Array<CacheScenarioResult>;
    failure?: string;
  } = {
    description:
      'Synthetic source fixture using the actual Fate JSON handler, generated API client, deploymentsPage descriptor and data view. This is protocol/cache behavior only, not portability, auth, or browser proof.',
    protocol: 'installed @nkzw/fate + original API descriptor/client',
    scenarios: [],
  };

  try {
    artifact.scenarios.push(await runScenario('absent'));
    artifact.scenarios.push(await runScenario('UTC'));

    const [withoutTimezone, withUtc] = artifact.scenarios;
    expect(withoutTimezone?.exchanges[0]?.status).toBe(200);
    expect(withUtc?.exchanges[0]?.status).toBe(200);
    expect(withoutTimezone?.exchanges[0]?.resultSummaries[0]?.ok).toBe(true);
    expect(withUtc?.exchanges[0]?.resultSummaries[0]?.ok).toBe(true);

    const fieldsWithoutTimezone = withoutTimezone?.exchanges[0]?.resultSummaries[0];
    const fieldsWithUtc = withUtc?.exchanges[0]?.resultSummaries[0];
    expect(fieldsWithoutTimezone?.selectedPaths).toContain('search');
    expect(fieldsWithoutTimezone?.selectedPaths).toContain('tz');
    expect(fieldsWithoutTimezone?.missingFields).toContain('search');
    expect(fieldsWithoutTimezone?.missingFields).toContain('tz');
    expect(fieldsWithUtc?.missingFields).toContain('search');
    expect(fieldsWithUtc?.missingFields).not.toContain('tz');
    expect(fieldsWithUtc?.presentFields).toContain('tz');

    // Fate treats the original unfiltered-page response as cache-complete even though
    // its selected optional search field is absent from the serialized record.
    expect(withUtc?.equivalentRequestTransportDelta).toBe(0);
    expect(withoutTimezone?.equivalentRequestTransportDelta).toBe(0);
  } catch (error) {
    artifact.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    if (resultPath) {
      await mkdir(dirname(resultPath), { recursive: true });
      await writeFile(resultPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    }
  }
});
