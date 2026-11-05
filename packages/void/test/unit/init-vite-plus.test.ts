import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { parse } from 'yaml';
import { configureVitePlusScaffold } from '../../src/cli/init-vite-plus.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from '../../src/cli/template.ts';

const roots: Array<string> = [];
function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-viteplus-config-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves pnpm catalogs, build approvals, comments, and unrelated overrides', () => {
  const root = temporaryProject();
  const file = join(root, 'pnpm-workspace.yaml');
  writeFileSync(
    file,
    '# Workspace policy\npackages: [apps/*]\ncatalog: { typescript: "^7.0.2" }\n' +
      'allowBuilds: { esbuild: false, workerd: true }\n' +
      'overrides: { vite: "^8.0.0", foo: "^2.0.0" }\n' +
      'peerDependencyRules: { allowedVersions: { react: "19" } }\n',
  );
  configureVitePlusScaffold(root, 'pnpm', {});
  const content = readFileSync(file, 'utf8');
  expect(content).toContain('# Workspace policy');
  expect(parse(content)).toEqual({
    packages: ['apps/*'],
    catalog: { typescript: '^7.0.2' },
    allowBuilds: { esbuild: false, workerd: true },
    overrides: { foo: '^2.0.0', 'vite@*': SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite },
    peerDependencyRules: { allowedVersions: { react: '19', vite: '*' } },
  });
});

it('preserves Yarn registry settings while selecting the supported node-modules linker', () => {
  const root = temporaryProject();
  writeFileSync(join(root, '.yarnrc.yml'), 'npmRegistryServer: https://registry.npmjs.org\n');
  const pkg = { resolutions: { foo: '^2.0.0' } };
  configureVitePlusScaffold(root, 'yarn', pkg);
  expect(pkg.resolutions).toEqual({
    foo: '^2.0.0',
    vite: SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite,
  });
  expect(parse(readFileSync(join(root, '.yarnrc.yml'), 'utf8'))).toEqual({
    npmRegistryServer: 'https://registry.npmjs.org',
    nodeLinker: 'node-modules',
  });
});

it('fails before overwriting malformed workspace configuration', () => {
  const root = temporaryProject();
  const file = join(root, 'pnpm-workspace.yaml');
  const malformed = 'overrides: [unclosed\n';
  writeFileSync(file, malformed);
  expect(() => configureVitePlusScaffold(root, 'pnpm', {})).toThrow(
    'Could not parse pnpm-workspace.yaml',
  );
  expect(readFileSync(file, 'utf8')).toBe(malformed);
});
