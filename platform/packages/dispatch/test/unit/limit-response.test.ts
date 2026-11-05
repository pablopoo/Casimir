import { describe, expect, it, vi } from 'vite-plus/test';
import { createLimitResponse } from '../../src/limit-response.ts';
const limit = {
  code: 'usage_limit',
  resource: 'requests',
  reason: 'monthly_quota',
  message: 'Temporarily unavailable',
} as const;
describe('platform limit responses', () => {
  it('serves a default document without invoking application code', async () => {
    const response = await createLimitResponse(
      new Request('https://app.test/', { headers: { accept: 'text/html' } }),
      limit,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Temporarily unavailable');
  });
  it.each(['/api/data', '/'])('keeps APIs and Pages requests structured for %s', async (path) => {
    const page = vi.fn();
    const response = await createLimitResponse(
      new Request('https://app.test' + path, {
        headers: { 'X-VoidPages': 'true', accept: 'text/html' },
      }),
      limit,
      page,
    );
    expect(await response.json()).toEqual(limit);
    expect(page).not.toHaveBeenCalled();
  });
  it('uses optional standalone HTML and falls back if it cannot be read', async () => {
    const request = new Request('https://app.test/');
    const response = await createLimitResponse(
      request,
      limit,
      async () =>
        new Response('<h1>Please come back later</h1>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    expect(await response.text()).toContain('Please come back later');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const fallback = await createLimitResponse(request, limit, async () => {
      throw new Error('assets unavailable');
    });
    expect(await fallback.text()).toContain('Temporarily unavailable');
  });
  it('returns a bodyless HEAD response and rejects non-HTML custom assets', async () => {
    const head = await createLimitResponse(
      new Request('https://app.test/', { method: 'HEAD' }),
      limit,
    );
    expect(await head.text()).toBe('');
    const response = await createLimitResponse(
      new Request('https://app.test/'),
      limit,
      async () => new Response('javascript'),
    );
    expect(await response.text()).not.toBe('javascript');
  });
});
