import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vite-plus/test';
import { formatDeploySummary, printDeployContext } from '../../src/cli/deploy-summary.ts';

describe('deployment summaries', () => {
  it('renders project context without allowing names to inject terminal controls', () => {
    const chunks: Array<string> = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      printDeployContext('blog\nforged', 'Orange\rCloud\u001b[2J');
    } finally {
      write.mockRestore();
    }
    expect(stripVTControlCharacters(chunks.join(''))).toBe('blog forged → Orange Cloud [2J\n\n');
  });

  it.each([1, 5])('uses correct nouns for %i deployed resources', (count) => {
    const suffix = count === 1 ? '' : 's';
    expect(
      formatDeploySummary({
        workers: count,
        assets: count,
        migrations: count,
        cronJobs: count,
        queues: count,
        prerenderedPages: count,
        revalidate: Object.fromEntries(Array.from({ length: count }, (_, i) => [`/page-${i}`, 60])),
        ssr: true,
      }),
    ).toBe(
      `${count} worker module${suffix}, ${count} static asset${suffix}\n` +
        `${count} migration${suffix} applied\n` +
        `${count} cron job${suffix} scheduled\n` +
        `${count} queue${suffix} configured\n` +
        `${count} page${suffix} prerendered\n` +
        `SSR enabled\nISR revalidate: ${count} path rule${suffix}`,
    );
  });

  it('includes unchanged asset counts and omits unused features', () => {
    expect(formatDeploySummary({ workers: 1, assets: 5, unchangedAssets: 4, migrations: 0 })).toBe(
      '1 worker module, 5 static assets (4 unchanged, 1 uploaded)',
    );
    expect(formatDeploySummary({ typeLabel: 'Static', assets: 0 })).toBe(
      'Static — 0 static assets',
    );
  });

  it('keeps unknown native counts absent and distinguishes verified D1 state from new migrations', () => {
    expect(
      formatDeploySummary({ workerName: 'blog', migrations: 1, d1MigrationsCurrent: true }),
    ).toBe('Worker: blog\n1 migration applied\nD1 migrations up to date');
    expect(formatDeploySummary({ workerName: 'site', typeLabel: 'SPA' })).toBe('Worker: site\nSPA');
  });

  it('includes the rendering configuration for framework deployments', () => {
    expect(formatDeploySummary({ workers: 1, assets: 1, revalidate: 60, framework: 'Astro' })).toBe(
      '1 worker module, 1 static asset\nISR revalidate: 60s\nFramework: Astro',
    );
  });
});
