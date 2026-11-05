import type { Context } from 'hono';
import { expect, it } from 'vite-plus/test';
import type { PlatformManagementEnv } from '../../src/env.ts';
import { requestTimezone } from '../../src/admin/fate/page-requests.ts';

const requestContext = (raw: Request) =>
  ({ req: { raw } }) as unknown as Context<PlatformManagementEnv>;

it('uses UTC when the request has no Cloudflare timezone metadata', () => {
  expect(requestTimezone(requestContext(new Request('https://admin.example/admin/')))).toBe('UTC');
});

it('preserves an explicit Cloudflare request timezone', () => {
  const raw = new Request('https://admin.example/admin/') as Request & {
    cf?: { timezone?: string };
  };
  raw.cf = { timezone: 'America/Santiago' };

  expect(requestTimezone(requestContext(raw))).toBe('America/Santiago');
});
