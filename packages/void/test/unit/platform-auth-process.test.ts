import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runCloudflareAuthCommand } from '../../src/cli/cloudflare-auth.ts';
import { resolvePlatformCloudflareCredentialWithInput } from '../../src/cli/platform-auth.ts';

const fixture = vi.hoisted(() => ({ source: '' }));
vi.mock('../../src/cli/preset.ts', () => ({
  resolveCloudflareOperationArgv: () => [process.execPath, '--eval', fixture.source, '--'],
}));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-platform-auth-process-'));
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
  vi.stubEnv('CF_API_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('non-blocking platform auth processes', () => {
  it('captures credential output and scrubs unrelated secrets from command environments', async () => {
    vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', 'synthetic-recovery-secret');
    vi.stubEnv('DATABASE_URL', 'synthetic-database-secret');
    fixture.source = `
      process.stdout.write(JSON.stringify({ operationResult: 1, data: {
        operation: JSON.parse(process.argv[1]),
        sanitize: process.env.WRANGLER_LOG_SANITIZE,
        recovery: process.env.VOID_PLATFORM_RECOVERY_KEY,
        database: process.env.DATABASE_URL,
      }}));
    `;
    const result = await runCloudflareAuthCommand(root, { type: 'auth.token' });
    expect(result.status).toBe(0);
    expect(result.data).toEqual({ operation: { type: 'auth.token' } });
    expect(result.stderr).toBe('');
  });

  it('preserves nonzero exit status without throwing raw subprocess output', async () => {
    fixture.source = `process.stderr.write('synthetic failure'); process.exit(7);`;
    const result = await runCloudflareAuthCommand(root, { type: 'auth.token' });
    expect(result.status).toBe(7);
    expect(result.stderr).toBe('synthetic failure');
  });

  it('keeps input responsive and terminates the background process on cancellation', async () => {
    const ready = join(root, 'ready');
    fixture.source = `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setTimeout(() => process.exit(2), 10_000);
    `;
    let pid: number | undefined;
    try {
      await expect(
        resolvePlatformCloudflareCredentialWithInput(
          async () => {
            // The input callback and timers must run while the child is still
            // alive; a synchronous auth process would block this entirely.
            await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
            pid = Number(readFileSync(ready, 'utf8'));
            expect(() => process.kill(pid!, 0)).not.toThrow();
            throw new Error('platform: Cancelled.');
          },
          { interactive: true },
        ),
      ).rejects.toThrow('platform: Cancelled.');
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
    } finally {
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* Already stopped. */
        }
      }
    }
  });

  it('cancels browser login on Ctrl+C and restores the signal listeners', async () => {
    const ready = join(root, 'login-ready');
    fixture.source = `
      const operation = JSON.parse(process.argv[1]);
      if (operation.type === 'auth.token') process.exit(1);
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setTimeout(() => process.exit(2), 10_000);
    `;
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const listeners = process.listeners('SIGINT');
    const result = resolvePlatformCloudflareCredentialWithInput(async () => 'team', {
      interactive: true,
    });
    const cancelled = expect(result).rejects.toThrow('platform: Cancelled.');
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      pid = Number(readFileSync(ready, 'utf8'));
      process.emit('SIGINT');
      await cancelled;
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
      expect(process.listeners('SIGINT')).toEqual(listeners);
    } finally {
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* Already stopped. */
        }
      }
    }
  });
});
