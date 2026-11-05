import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type Server, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { CasimirClient } from '../../src/cli/casimir-client.ts';
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
} as const;
const servers: Array<Server> = [],
  roots: Array<string> = [];
async function server(handler: RequestListener) {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const p of roots.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});
it('connects only with origin-bound token and never forwards through redirects', async () => {
  let wrong = 0;
  const other = await server((_req, res) => {
    wrong++;
    res.end('{}');
  });
  let auth: string | undefined;
  const base = await server((req, res) => {
    auth = req.headers.authorization;
    if (req.url === '/casimir/v1/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(runtime));
    } else {
      res.writeHead(302, { Location: other });
      res.end();
    }
  });
  expect(() => new CasimirClient(base, { token: 'synthetic', origin: other })).toThrow(
    'credential_origin',
  );
  const client = new CasimirClient(base, { token: 'synthetic', origin: base });
  await expect(client.connect()).rejects.toThrow('redirect');
  expect(auth).toBe('Bearer synthetic');
  expect(wrong).toBe(0);
});
it('rejects incompatible ABI/profile before authenticated identity', async () => {
  let identity = 0;
  const base = await server((req, res) => {
    if (req.url?.endsWith('/identity')) {
      identity++;
    }
    res.end(JSON.stringify({ ...runtime, nodeAbi: '999' }));
  });
  await expect(
    new CasimirClient(base, { token: 'synthetic', origin: base }).connect(),
  ).rejects.toThrow('runtime_mismatch');
  expect(identity).toBe(0);
});
it('streams uploads and preserves the exact idempotency key for a lost admission response', async () => {
  const keys: Array<string> = [],
    bodies: Array<unknown> = [];
  let attempts = 0;
  const base = await server(async (req, res) => {
    const chunks: Array<Buffer> = [];
    for await (const c of req) {
      chunks.push(c);
    }
    const bytes = Buffer.concat(chunks);
    if (req.url === '/casimir/v1/info') {
      res.end(JSON.stringify(runtime));
    } else if (req.url === '/casimir/v1/identity') {
      res.end(JSON.stringify({ actorId: 'operator' }));
    } else if (req.url?.endsWith('/uploads')) {
      bodies.push(JSON.parse(bytes.toString()));
      res.end(JSON.stringify({ uploadId: 'upl_test' }));
    } else if (req.url?.endsWith('/content')) {
      expect(bytes.toString()).toBe('artifact bytes');
      res.end('{}');
    } else if (req.url?.endsWith('/finalize')) {
      res.end(JSON.stringify({ artifactId: 'car_test' }));
    } else {
      keys.push(String(req.headers['idempotency-key']));
      bodies.push(JSON.parse(bytes.toString()));
      if (attempts++ === 0) {
        res.destroy();
        return;
      }
      res.end(JSON.stringify({ operationId: 'op_test', deploymentId: 'dpl_test' }));
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'casimir-client-'));
  roots.push(root);
  const path = join(root, 'artifact.gz');
  await writeFile(path, 'artifact bytes');
  const client = new CasimirClient(base, { token: 'synthetic', origin: base });
  expect(await client.connect()).toEqual(runtime);
  expect(await client.upload('project', path)).toEqual({ artifactId: 'car_test' });
  await expect(client.deploy('project', 'car_test', 'stable-key')).rejects.toThrow();
  expect(await client.deploy('project', 'car_test', 'stable-key')).toEqual({
    operationId: 'op_test',
    deploymentId: 'dpl_test',
  });
  expect(keys).toEqual(['stable-key', 'stable-key']);
  expect(bodies[0]).toMatchObject({ bytes: 14 });
});
it('bounds failed authentication and slow responses without exposing a token', async () => {
  const base = await server((_req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'server controlled text synthetic-secret' }));
  });
  const client = new CasimirClient(base, { token: 'synthetic-secret', origin: base });
  await expect(client.connect()).rejects.toThrow('http_401');
  const slow = await server(() => {});
  await expect(
    new CasimirClient(slow, { token: 'synthetic', origin: slow }, { timeout: 30 }).connect(),
  ).rejects.toThrow('request_failed');
});
