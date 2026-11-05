import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCasimirManifest, type CasimirManifest } from '@void/deploy-core';
import { expect, it } from 'vite-plus/test';
import type { DeployManifest } from '../../src/types.ts';
import { parseDeploymentManifest } from '../../src/admin/fate/deployment-detail-page.ts';
import { DeploymentManifestCard } from '../../src/admin/react/views/DeploymentManifestCard.tsx';

const hash = 'a'.repeat(64);
const nativeManifest: CasimirManifest = parseCasimirManifest({
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: hash,
  platform: 'linux/amd64',
  nodeAbi: '137',
  entry: 'dist/ssr/app.js',
  files: [
    { path: 'db/migrations/0001_init.sql', size: 41, sha256: hash },
    { path: 'dist/ssr/app.js', size: 24, sha256: hash },
  ],
  migrations: [
    { name: '0001_init.sql', path: 'db/migrations/0001_init.sql', sha256: hash },
  ],
  envKeys: ['APP_MODE'],
  compatibilityEntry: null,
});

it('renders original Void manifest dialect and pending migrations with the raw JSON disclosure', () => {
  const manifest: DeployManifest = {
    version: 4,
    bindings: { d1: ['PRIMARY_DB'] },
    migrations: { dialect: 'sqlite', pending: 2 },
    schedules: [{ name: 'refresh', cron: '0 * * * *' }],
  };
  const html = renderToStaticMarkup(createElement(DeploymentManifestCard, { manifest }));

  expect(html).toContain('D1');
  expect(html).toContain('sqlite');
  expect(html).toContain('2 pending');
  expect(html).toContain('refresh: 0 * * * *');
  expect(html).toContain('Raw JSON');
  expect(html).toContain('&quot;dialect&quot;: &quot;sqlite&quot;');
  expect(parseDeploymentManifest('casimir-record', JSON.stringify(manifest))).toEqual(manifest);
});

it('renders a validated Casimir manifest as included metadata, not Void pending migrations', () => {
  const html = renderToStaticMarkup(
    createElement(DeploymentManifestCard, { manifest: nativeManifest }),
  );

  expect(html).toContain('Runtime protocol');
  expect(html).toContain('node-sqlite-v1');
  expect(html).toContain('Runtime ID');
  expect(html).toContain(hash);
  expect(html).toContain('Node ABI');
  expect(html).toContain('137');
  expect(html).toContain('0001_init.sql');
  expect(html).not.toContain('pending');
  expect(html).not.toContain('OCI');
  expect(html).toContain('Raw JSON');
  expect(html).toContain('&quot;runtimeId&quot;');
  expect(parseDeploymentManifest('casimir-artifact', JSON.stringify(nativeManifest))).toEqual(
    nativeManifest,
  );
  expect(() =>
    parseDeploymentManifest(
      'casimir-artifact',
      JSON.stringify({ ...nativeManifest, runtimeId: 'not-a-runtime-id' }),
    ),
  ).toThrow('runtime_descriptor');
});
