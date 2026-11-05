import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { parseDeployArgs } from '../../src/cli/args.ts';
import {
  runCasimirConnect,
  readCasimirLink,
  readCasimirCredential,
} from '../../src/cli/casimir-connect.ts';
import { parseConnectArgs } from '../../src/cli/connect-args.ts';
import { readDeploymentPlatform } from '../../src/cli/project.ts';
const runtime = {
  protocol: 1,
  profile: 'node-sqlite-v1',
  sdkVersion: '1.1.11',
  runtimeId: 'a'.repeat(64),
  platform: 'linux/amd64',
  nodeAbi: '137',
};
const roots: Array<string> = [],
  servers: Array<Server> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const p of roots.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});
it('selects the explicit Casimir CLI destination without changing runtime target', () => {
  expect(parseConnectArgs(['http://localhost:4285', '--platform', 'casimir']).platform).toBe(
    'casimir',
  );
  expect(parseDeployArgs(['--platform', 'casimir', '--project', 'internal-tools']).platform).toBe(
    'casimir',
  );
});
it('stores a separate origin-bound credential and public connection metadata, preserving the Void link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'casimir-connect-'));
  roots.push(root);
  const home = join(root, 'private');
  vi.stubEnv('CASIMIR_CONFIG_DIR', home);
  const s = createServer((req, res) => {
    res.end(JSON.stringify(req.url?.endsWith('/info') ? runtime : { actorId: 'operator' }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  vi.stubEnv('CASIMIR_TOKEN', 'synthetic-control');
  vi.stubEnv('CASIMIR_API_URL', origin);
  await mkdir(join(root, '.void'));
  await writeFile(
    join(root, '.void/project.json'),
    JSON.stringify({
      platform: 'void',
      projectId: 'old_void_project',
      slug: 'old-void',
      platformUrl: 'https://void.invalid',
    }),
  );
  await runCasimirConnect(root, origin);
  expect(readDeploymentPlatform(root)).toBe('casimir');
  expect(readCasimirLink(root).origin).toBe(origin);
  const project = await readFile(join(root, '.void/project.json'), 'utf8');
  expect(project).not.toContain('synthetic-control');
  expect(JSON.parse(project).projectId).toBe('old_void_project');
  vi.stubEnv('CASIMIR_TOKEN', '');
  vi.stubEnv('CASIMIR_API_URL', '');
  const credential = readCasimirCredential(origin);
  expect(credential.token).toBe('synthetic-control');
  expect((await stat(join(home, 'credentials.json'))).mode & 0o777).toBe(0o600);
  vi.stubEnv('CASIMIR_TOKEN', 'synthetic-control');
  vi.stubEnv('CASIMIR_API_URL', 'https://other.invalid');
  expect(() => readCasimirCredential(origin)).toThrow('credential_origin');
});
