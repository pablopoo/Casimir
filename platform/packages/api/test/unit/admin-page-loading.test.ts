import { Hono } from 'hono';
import { expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';

const { loaded } = vi.hoisted(() => ({ loaded: [] as Array<string> }));

vi.mock('../../src/admin/react/AdminProviders.tsx', () => {
  loaded.push('layout');
  return { AdminProviders: () => null };
});

vi.mock('../../src/admin/react/views/DashboardPage.tsx', () => {
  loaded.push('dashboard');
  return { DashboardPage: () => null };
});

it('loads only requested views and skips them for page-protocol responses', async () => {
  const { adminComponents, adminLayoutTree, matchAdminRoute } =
    await import('../../src/admin/react/pages.ts');
  const { renderAdminPage } = await import('../../src/admin/react/server.ts');

  expect(loaded).toEqual([]);
  expect(adminLayoutTree.dashboard).toEqual(['adminLayout']);
  expect(matchAdminRoute('/admin/')).toBe('dashboard');

  const app = new Hono<ApiEnv>().get('/admin/', (context) =>
    renderAdminPage(context, 'dashboard', 'Dashboard', { platformName: 'Test' }),
  );
  const response = await app.request('/admin/', { headers: { 'X-VoidPages': 'true' } });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    component: 'dashboard',
    props: { platformName: 'Test' },
  });
  expect(loaded).toEqual([]);

  const dashboard = await adminComponents.dashboard();
  expect(typeof dashboard.default).toBe('function');
  expect((await adminComponents.dashboard()).default).toBe(dashboard.default);
  expect(loaded).toEqual(['dashboard']);

  expect(typeof (await adminComponents.adminLayout()).default).toBe('function');
  expect(loaded).toEqual(['dashboard', 'layout']);
});
