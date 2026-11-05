import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPlanCatalog, PLAN_LIMITS } from '@void/platform/plans';
import { confirm, outro, select, text } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { parsePlatformPlansArgs } from '../../src/cli/platform-plans-args.ts';
import { runPlatformPlansConfig } from '../../src/cli/platform-plans-config.ts';

vi.mock('../../src/cli/operator-auth.ts', () => ({
  resolveOperatorOrigin: () => 'https://api.example.com',
  readOperatorToken: () => 'operator-fixture',
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  outro: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
let directory: string;
let calls: Array<{ url: string; body?: Record<string, unknown> }>;
let revision = 7;
let pending = false;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'void-plans-config-'));
  calls = [];
  revision = 7;
  pending = false;
  vi.mocked(confirm).mockReset();
  vi.mocked(outro).mockReset();
  vi.mocked(select).mockReset();
  vi.mocked(text).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      const catalog = {
        revision,
        defaultPlanId: 'custom',
        plans: [
          {
            id: 'custom',
            name: 'Custom',
            archived: false,
            limits: PLAN_LIMITS.custom,
            buildInstanceType: 'standard-4',
          },
          {
            id: 'free',
            name: 'Free',
            archived: false,
            limits: PLAN_LIMITS.free,
            buildInstanceType: 'standard-3',
          },
        ],
        reconciliation: null,
      };
      if (init?.method === 'GET') {
        return Response.json({ catalog, accounts: [{ planId: 'free', count: 2 }] });
      }
      if (body?.dryRun) {
        return Response.json({
          dryRun: true,
          expectedRevision: revision,
          catalog,
          affectedAccounts: 2,
          overLimitAccounts: [],
        });
      }
      if (body?.expectedRevision !== revision) {
        return Response.json(
          { error: 'revision_conflict', message: 'Plan configuration changed; preview again.' },
          { status: 409 },
        );
      }
      return Response.json({ catalog, reconciliation: { complete: !pending, processed: 2 } });
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe('platform config plans', () => {
  it('shows the replacement and changed limits in a removal preview', async () => {
    const catalog = createDefaultPlanCatalog('custom');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return Response.json({ catalog, accounts: [{ planId: 'custom', count: 2 }] });
        }
        return Response.json({
          dryRun: true,
          action: 'plans.remove',
          target: 'custom',
          expectedRevision: 0,
          removedPlanId: 'custom',
          replacementPlanId: 'free',
          affectedAccounts: 2,
          catalog: {
            ...catalog,
            revision: 1,
            defaultPlanId: 'free',
            plans: catalog.plans.filter((plan) => plan.id !== 'custom'),
          },
        });
      }),
    );
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'remove', 'custom', '--replacement', 'free', '--plan']),
    );
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(output).toContain('Move accounts to free (free)');
    expect(output).toContain('Requests per billing month: unlimited → 3,000,000');
    expect(output).toContain('Build size: standard-4 → standard-3');
    expect(output).toContain('Short project slugs: allowed → not allowed');
  });

  it('routes plan configuration independently from authentication and operator account assignment', () => {
    expect(parsePlatformArgs(['config', 'plans'])).toMatchObject({
      configGroup: 'plans',
      action: '',
    });
    expect(parsePlatformArgs(['config'])).toEqual({
      subcommand: 'config',
      configGroup: '',
      plan: false,
      yes: false,
    });
    expect(parsePlatformArgs(['config', 'auth'])).not.toHaveProperty('configGroup');
    expect(parsePlatformArgs(['user', 'plan', 'user-1', 'company'])).toMatchObject({
      group: 'user',
      action: 'plan',
      body: { plan: 'company' },
    });
  });
  it.each([
    ['plans', 'remove'],
    ['plans', 'show', 'free', '--file', 'x'],
    ['plans', 'sync', 'free'],
    ['plans', 'set', '../free', '--name', 'New'],
    ['plans', 'add', 'team', '--copy', 'free', '--plan', '--yes'],
    ['plans', 'add', 'team', '--copy', 'free', '--copy', 'pro'],
    ['plans', 'set', 'free', '--replacement', 'pro'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parsePlatformPlansArgs(args)).toThrow();
  });
  it('prints a read-only preview with partial numeric limits and preserved plan identity', async () => {
    const file = join(directory, 'limits.json');
    await writeFile(
      file,
      JSON.stringify({ name: 'Team', limits: { requestsPerMonth: 10_000_000 } }),
    );
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--plan', '--json']),
    );
    expect(calls.filter((call) => call.body)).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/free/set',
        body: { name: 'Team', limits: { requestsPerMonth: 10_000_000 }, dryRun: true },
      },
    ]);
    expect(console.log).toHaveBeenCalledTimes(1);
  });
  it('copies a plan, previews, then applies using the exact preview revision', async () => {
    await runPlatformPlansConfig(
      parsePlatformPlansArgs([
        'plans',
        'add',
        'team',
        '--copy',
        'free',
        '--name',
        'Team',
        '--yes',
        '--json',
      ]),
    );
    expect(calls.filter((call) => call.body)).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/add',
        body: { id: 'team', copyFrom: 'free', name: 'Team', dryRun: true },
      },
      {
        url: 'https://api.example.com/operator/v1/config/plans/add',
        body: { id: 'team', copyFrom: 'free', name: 'Team', expectedRevision: 7 },
      },
    ]);
  });
  it.each(['d1StorageBytes', 'unknownLimit'])(
    'rejects unsupported limit %s before any mutation',
    async (key) => {
      const file = join(directory, 'limits.json');
      await writeFile(file, JSON.stringify({ limits: { [key]: 100 } }));
      await expect(
        runPlatformPlansConfig(
          parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--yes']),
        ),
      ).rejects.toThrow();
      expect(calls.filter((call) => call.body)).toHaveLength(0);
    },
  );
  it('accepts the copied short-slug permission override only as a boolean', async () => {
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify({ allowShortSlugs: true }));
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--plan', '--json']),
    );
    expect(calls.at(-1)?.body).toEqual({ allowShortSlugs: true, dryRun: true });
    await writeFile(file, JSON.stringify({ allowShortSlugs: 'true' }));
    await expect(
      runPlatformPlansConfig(
        parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--yes']),
      ),
    ).rejects.toThrow('must be a boolean');
    expect(calls.filter((call) => call.body)).toHaveLength(1);
  });
  it('requires explicit headless application before sending a preview', async () => {
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'archive', 'free'])),
    ).rejects.toThrow('--yes or --plan');
    expect(calls.filter((call) => call.body)).toHaveLength(0);
  });
  it('archives reversibly and removes with an explicit replacement', async () => {
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'restore', 'free', '--yes']));
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'remove', 'free', '--replacement', 'custom', '--yes']),
    );
    expect(calls.filter((call) => call.body && !call.body.dryRun).map((call) => call.body)).toEqual(
      [
        { archived: false, expectedRevision: 7 },
        { replacementPlanId: 'custom', expectedRevision: 7 },
      ],
    );
  });
  it('reports pending updates as failure with a visible resumption command', async () => {
    pending = true;
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'sync', '--yes', '--json'])),
    ).rejects.toMatchObject({ code: 'plan_sync_pending' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.url).toBe('https://api.example.com/operator/v1/config/plans/sync');
  });
  it('makes interactive limit selection readable and previews changes before confirmation', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(select).mockResolvedValueOnce('requestsPerMonth');
    vi.mocked(text).mockResolvedValueOnce('10000000');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'set', 'free']));
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'requestsPerMonth',
            label: 'Requests per billing month: 3,000,000',
          }),
        ]),
      }),
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Requests per billing month (0 means unlimited):' }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.body).toEqual({
      limits: { requestsPerMonth: 10_000_000 },
      expectedRevision: 7,
    });
  });
  it('rejects a stale interactive preview without retrying the change', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(confirm).mockImplementationOnce(async () => {
      revision = 8;
      return true;
    });
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'archive', 'free'])),
    ).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    expect(calls.filter((call) => call.body)).toHaveLength(2);
    expect(calls.at(-1)?.body).toEqual({ archived: true, expectedRevision: 7 });
  });
  it('continues successful batches with one confirmation and the exact committed policy revision', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const before = { ...createDefaultPlanCatalog(), revision: 7 };
    const saved = {
      ...before,
      revision: 8,
      reconciliation: { revision: 8, planIds: ['free'], cursor: 'a', complete: false },
    };
    const next = { ...saved, reconciliation: { ...saved.reconciliation, cursor: 'b' } };
    const complete = { ...next, reconciliation: { ...next.reconciliation, complete: true } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ catalog: before, accounts: [{ planId: 'free', count: 50 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'plans.reset',
          target: 'free',
          expectedRevision: 7,
          catalog: saved,
          affectedAccounts: 50,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          action: 'plans.reset',
          target: 'free',
          catalog: saved,
          affectedAccounts: 50,
          reconciliation: { complete: false, processed: 25 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ catalog: next, reconciliation: { complete: false, processed: 25 } }),
      )
      .mockResolvedValueOnce(
        Response.json({ catalog: complete, reconciliation: { complete: true, processed: 0 } }),
      );
    vi.stubGlobal('fetch', fetcher);
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'reset', 'free']));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls
        .slice(3)
        .map(([input, init]) => ({ url: input.toString(), body: JSON.parse(String(init?.body)) })),
    ).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
    ]);
    expect(console.log).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledExactlyOnceWith(
      `\n${pc.green('✓ Saved plans.reset free. Account updates complete.')}`,
      { withGuide: false },
    );
  });
});
