import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type TestFile = { path: string; project: string; source: string };
export type AffectedTestPlan = {
  full: boolean;
  build: boolean;
  forced: Set<string>;
  related: Array<string>;
  reasons: Array<string>;
};

export function planAffectedTests(
  changes: Array<string>,
  tests: Array<TestFile>,
  deleted: Array<string> = [],
): AffectedTestPlan {
  const forced = new Set<string>();
  const reasons = new Set<string>();
  const related = new Set<string>();
  let full = false;
  let build = false;
  const select = (predicate: (test: TestFile) => boolean, reason: string) => {
    tests.filter(predicate).forEach((test) => forced.add(test.path));
    if (tests.length) {
      reasons.add(reason);
    }
  };
  const sdkIntegration = (test: TestFile) => test.project === 'parallel-integration';
  for (const changed of changes) {
    const path = changed.replaceAll('\\', '/');
    if (
      (path.startsWith('docs/') && /\.(md|svg|png|jpe?g|webp|gif|css)$/.test(path)) ||
      (!path.startsWith('playground/') &&
        /(^|\/)(AGENTS|README|TESTING|CONTRIBUTING|CHANGELOG)\.md$/.test(path))
    ) {
      continue;
    }
    if (
      deleted.includes(changed) ||
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|[^/]*config\.[^/]+|\.node-version|\.npmrc)$/.test(
        path,
      ) ||
      /^(test|scripts|\.github)\//.test(path)
    ) {
      full = true;
      build = true;
      reasons.add('Deleted files, configuration, dependencies, or shared test tooling changed.');
      continue;
    }
    related.add(path);
    const sdk = path.match(/^(packages\/[^/]+)\/(.+)$/);
    const platform = path.match(/^(platform\/packages\/[^/]+)\/(.+)$/);
    const playground = path.match(/^playground\/([^/]+)\//);
    if (sdk) {
      if (!sdk[2].startsWith('test/')) {
        build = true;
        select(sdkIntegration, 'SDK changes require real build/server/browser coverage.');
      } else if (!tests.some((test) => test.path === path)) {
        select(
          (test) => test.path.startsWith(`${sdk[1]}/test/`),
          'Package test fixtures/helpers require their owning suites.',
        );
      }
    } else if (platform) {
      if (!tests.some((test) => test.path === path)) {
        select(
          (test) => test.path.startsWith(`${platform[1]}/test/`),
          'Platform sources, database migrations, and fixtures require their owning suites.',
        );
      }
    } else if (playground) {
      const consumers = tests.filter((test) =>
        test.source.replaceAll('\\', '/').includes(`playground/${playground[1]}`),
      );
      select(
        consumers.length ? (test) => consumers.includes(test) : sdkIntegration,
        consumers.length
          ? `Playground ${playground[1]} requires its filesystem/subprocess consumers.`
          : `Unmapped playground ${playground[1]} requires all SDK integrations.`,
      );
    } else {
      full = true;
      build = true;
      reasons.add(`No safe ownership rule for ${path}; running the full selection.`);
    }
  }
  return { full, build, forced, related: [...related], reasons: [...reasons] };
}

export function deletedFiles(root: string, files: Array<string>): Array<string> {
  return files.filter((file) => !existsSync(join(root, file)));
}
