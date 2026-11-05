import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('Cloudflare compatibility flags in real builds', () => {
  // The direct wrangler/config suites cover individual merge and dedup cases. One real
  // build covers the integration seam where both config sources reach Cloudflare's plugin.
  it('merges both config sources and emits each flag once', () => {
    const playground = createIsolatedPlayground(ROOT, 'playground/ssr');
    try {
      const configPath = join(playground.root, 'void.config.ts');
      const config = readConfig(playground.root);
      const rootConfig = renderVoidConfig({
        ...config,
        worker: { ...config.worker, compatibility_flags: ['nodejs_als', 'url_standard'] },
        cloudflare: {
          ...config.cloudflare,
          name: 'compatibility-test',
          compatibility_date: '2026-02-24',
          compatibility_flags: ['nodejs_als', 'global_fetch_strictly_public', 'nodejs_als'],
        },
      });
      writeFileSync(configPath, rootConfig);

      // Build the isolated fixture directly: parallel tests add and remove other
      // playgrounds, which can race with workspace package-graph discovery.
      const result = spawn.sync('vp', ['build'], {
        cwd: playground.root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

      const generated = JSON.parse(
        readFileSync(join(playground.root, 'dist/ssr/wrangler.json'), 'utf8'),
      );
      expect(generated.compatibility_flags).toEqual([
        'nodejs_als',
        'url_standard',
        'global_fetch_strictly_public',
      ]);
      expect(readFileSync(configPath, 'utf8')).toBe(rootConfig);
    } finally {
      playground.cleanup();
    }
  });
});
