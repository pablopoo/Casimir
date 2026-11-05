import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
import { runCasimirConnect } from '../../src/cli/casimir-connect.ts';
import { runCasimirDeploy } from '../../src/cli/casimir-deploy.ts';
it('receipt_retry_survives_cli_disconnect without a second upload or a new idempotency key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-cli-retry-'));
  const projectId = 'proj_aaaaaaaaaaaa',
    artifactId = 'car_aaaaaaaaaaaa',
    operationId = 'cmv_aaaaaaaaaaaa',
    deploymentId = 'dpl_aaaaaaaaaaaa';
  let uploads = 0,
    admissions = 0;
  const keys: Array<string> = [];
  let sawPersistedReceipt = false;
  const runtime = {
    protocol: 1,
    profile: 'node-sqlite-v1',
    sdkVersion: '1.1.11',
    runtimeId: 'a'.repeat(64),
    platform: 'linux/amd64',
    nodeAbi: '137',
  };
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the real request before replying.
    }
    const url = req.url ?? '';
    if (url.endsWith('/info')) {
      res.end(JSON.stringify(runtime));
    } else if (url.endsWith('/identity')) {
      res.end(JSON.stringify({ actorId: 'operator' }));
    } else if (url.includes('/projects/by-slug/') || url === `/projects/${projectId}`) {
      res.end(JSON.stringify({ id: projectId, slug: 'internal-tools' }));
    } else if (url.endsWith('/uploads')) {
      uploads++;
      res.end(JSON.stringify({ uploadId: 'upl_aaaaaaaaaaaa' }));
    } else if (url.endsWith('/content')) {
      res.end('{}');
    } else if (url.endsWith('/finalize')) {
      res.end(JSON.stringify({ artifactId }));
    } else if (url.endsWith('/deployments')) {
      keys.push(String(req.headers['idempotency-key']));
      if (admissions++ === 0) {
        res.destroy();
        return;
      }
      res.end(JSON.stringify({ operationId, deploymentId }));
    } else {
      const local = JSON.parse(readFileSync(join(root, '.void/casimir.retry.json'), 'utf8'));
      sawPersistedReceipt = local.receipt?.operationId === operationId;
      res.end(
        JSON.stringify({
          operationId,
          phase: 'succeeded',
          outcome: 'activated',
          desired: { deploymentId, artifactId, imageId: 'sha256:' + 'b'.repeat(64) },
          verifiedServing: {
            deploymentId,
            artifactId,
            imageId: 'sha256:' + 'b'.repeat(64),
            observedAt: new Date().toISOString(),
          },
          error: null,
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    vi.stubEnv('CASIMIR_TOKEN', 'synthetic-control');
    vi.stubEnv('CASIMIR_API_URL', origin);
    vi.stubEnv('CASIMIR_CONFIG_DIR', join(root, 'credentials'));
    await mkdir(join(root, 'dist/ssr'), { recursive: true });
    await writeFile(join(root, 'dist/ssr/app.js'), 'export default {fetch:()=>new Response("ok")}');
    await writeFile(
      join(root, 'void.json'),
      JSON.stringify({ target: 'node', casimir: { profile: 'node-sqlite-v1' } }),
    );
    await runCasimirConnect(root, origin);
    await expect(
      runCasimirDeploy(root, { projectSlug: 'internal-tools', skipBuild: true }),
    ).rejects.toThrow();
    const pending = JSON.parse(await readFile(join(root, '.void/casimir.retry.json'), 'utf8'));
    expect(pending.key).toBe(keys[0]);
    expect(pending.artifactId).toBe(artifactId);
    expect(JSON.stringify(pending)).not.toContain('synthetic-control');
    await runCasimirDeploy(root, { projectSlug: 'internal-tools', skipBuild: true });
    expect(uploads).toBe(1);
    expect(keys).toEqual([pending.key, pending.key]);
    expect(sawPersistedReceipt).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, '.void/casimir.retry.json'), 'utf8')).finished,
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
