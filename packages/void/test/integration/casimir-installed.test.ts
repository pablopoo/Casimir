import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';
import { buildCasimirArtifact, extractCasimirArtifact } from '../../src/cli/casimir-artifact.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
function run(args: Array<string>, cwd: string): string {
  try {
    return execFileSync('pnpm', args, {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 12 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${result.message}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, {
      cause: error,
    });
  }
}
function sourceFiles(root: string): Array<string> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('installed Casimir SDK native starter', () => {
  let root: string, devBase: string, prodBase: string;
  let dev: ReturnType<typeof spawn>, prod: ReturnType<typeof spawn>;
  const secret = 'casimir-synthetic-server-only-6f0b9b';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'casimir-mvp-a-installed-'));
    const archives = join(root, 'archives');
    run(['exec', 'node', 'casimir/mvp-a/pack-sdk.mjs', archives], ROOT);
    const catalog = JSON.parse(readFileSync(join(archives, 'catalog.json'), 'utf8'));
    const overrides = Object.fromEntries(
      Object.entries(catalog).map(([name, value]) => [
        name,
        `file:${join(archives, (value as { filename: string }).filename)}`,
      ]),
    );
    cpSync(join(ROOT, 'casimir/examples/notes'), root, { recursive: true });
    const helper = join(root, 'helper');
    mkdirSync(helper);
    writeFileSync(
      join(helper, 'package.json'),
      JSON.stringify({
        name: 'casimir-installed-reader',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './index.d.ts', import: './index.mjs' } },
        peerDependencies: { void: '1.1.11' },
      }),
    );
    writeFileSync(
      join(helper, 'index.mjs'),
      `
import { db } from 'void/db'; import { env } from 'void/env';
import { messages } from '@schema';
export async function inspect() { return { count: (await db.select().from(messages)).length,
  configured: Boolean(env.SERVER_ONLY) }; }
`,
    );
    writeFileSync(
      join(helper, 'index.d.ts'),
      'export declare function inspect():Promise<{count:number;configured:boolean}>;\n',
    );
    run(['--dir', helper, 'pack', '--pack-destination', archives], ROOT);
    writeFileSync(
      join(root, 'routes/api/dependency.ts'),
      `
import { defineHandler } from 'void'; import { inspect } from 'casimir-installed-reader';
export const GET = defineHandler(inspect);
`,
    );
    writeFileSync(
      join(root, 'db/type-contract.ts'),
      `
import { db } from 'void/db'; import { messages } from './schema';
// @ts-expect-error D1 bindings are not part of the native target's API.
import { createDb } from 'void/db';
// @ts-expect-error Schema inference must reject numeric text.
db.insert(messages).values({text: 42});
void createDb;
`,
    );
    writeFileSync(
      join(root, 'routes/api/internal-binding.ts'),
      `
import { defineHandler } from 'void'; import { getRuntimeEnv } from 'void/_env';
export const GET = defineHandler(() => ({visible:Object.hasOwn(getRuntimeEnv(),'CASIMIR_SQLITE_PATH')}));
`,
    );
    const version = (name: string) =>
      JSON.parse(
        readFileSync(join(ROOT, 'playground/node-app/node_modules', name, 'package.json'), 'utf8'),
      ).version;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'casimir-installed-notes',
          private: true,
          type: 'module',
          dependencies: {
            void: overrides.void,
            '@void/react': overrides['@void/react'],
            '@void/deploy-core': overrides['@void/deploy-core'],
            'casimir-installed-reader': `file:${join(archives, 'casimir-installed-reader-1.0.0.tgz')}`,
            '@hono/node-server': version('@hono/node-server'),
            react: version('react'),
            'better-sqlite3': JSON.parse(
              readFileSync(
                join(ROOT, 'packages/void/node_modules/better-sqlite3/package.json'),
                'utf8',
              ),
            ).version,
            'react-dom': version('react-dom'),
          },
          devDependencies: {
            vite: 'npm:@voidzero-dev/vite-plus-core@1.2.0',
            'vite-plus': '1.2.0',
            typescript: JSON.parse(
              readFileSync(join(ROOT, 'node_modules/typescript/package.json'), 'utf8'),
            ).version,
            '@types/react': '19.3.0',
            '@types/react-dom': '19.3.0',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      [
        'packages: []',
        'allowBuilds:',
        '  better-sqlite3: true',
        'overrides:',
        ...Object.entries(overrides).map(
          ([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
        ),
        '',
      ].join('\n'),
    );
    run(
      [
        'install',
        process.env.CASIMIR_TEST_OFFLINE === '1' ? '--offline' : '--prefer-offline',
        '--ignore-scripts',
      ],
      root,
    );
    run(['rebuild', 'better-sqlite3'], root);
    expect(realpathSync(join(root, 'node_modules/void')).startsWith(root)).toBe(true);
    writeFileSync(join(root, '.env'), `SERVER_ONLY=${secret}\n`);
    const server = await startServer((port) => {
      dev = spawn(
        'pnpm',
        ['exec', 'vp', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      return dev;
    }, 60_000);
    devBase = server.base;
  }, 240_000);

  afterAll(async () => {
    if (dev) {
      await killChild(dev);
    }
    if (prod) {
      await killChild(prod);
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs actual typed API, SDK DB and installed dependency in local development', async () => {
    const response = await fetch(`${devBase}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'persist café 👀' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ id: number; text: string }> };
    expect(body.rows[0]).toMatchObject({ id: 1, text: 'persist café 👀' });
    expect(await (await fetch(`${devBase}/api/dependency`)).json()).toEqual({
      count: 1,
      configured: true,
    });
    expect(await (await fetch(`${devBase}/`)).text()).toContain('persist café');
  });

  it('hydrates the starter form and saves a message through its server action', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(devBase);
      await page.getByRole('textbox', { name: 'Message' }).fill('browser record');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('listitem').filter({ hasText: 'browser record' }).waitFor();
      expect(await page.getByRole('listitem').count()).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it('builds native declarations and serves SSR/assets from a changed working directory', async () => {
    run(['exec', 'vp', 'build'], root);
    run(['exec', 'tsc', '--noEmit'], root);
    const runtime = {
      protocol: 1,
      profile: 'node-sqlite-v1',
      sdkVersion: '1.1.11',
      runtimeId: 'a'.repeat(64),
      platform: 'linux/amd64',
      nodeAbi: process.versions.modules,
    } as const;
    const artifact = await buildCasimirArtifact(root, runtime);
    run(
      [
        'exec',
        'node',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { parseCasimirManifest } from '@void/deploy-core';
      const manifest = ${JSON.stringify(artifact.manifest)};
      assert.deepEqual(parseCasimirManifest(manifest), manifest);
    `,
      ],
      root,
    );
    const unpacked = join(root, 'roundtrip');
    expect((await extractCasimirArtifact(artifact.path, unpacked, runtime)).manifest).toEqual(
      artifact.manifest,
    );
    const client = sourceFiles(join(root, 'dist/client'))
      .map((path) => readFileSync(path).toString())
      .join('\n');
    expect(client.includes(secret)).toBe(false);
    writeFileSync(join(root, 'runtime-private.json'), JSON.stringify({ SERVER_ONLY: secret }));
    writeFileSync(
      join(root, 'serve.mjs'),
      `
import { setCasimirEnv } from 'void/_casimir-env';
import { readFileSync } from 'node:fs';
setCasimirEnv({...JSON.parse(readFileSync(${JSON.stringify(join(root, 'runtime-private.json'))}, 'utf8')),CASIMIR_SQLITE_PATH:process.env.CASIMIR_SQLITE_PATH});
await import('./dist/ssr/index.js');
`,
    );
    const server = await startServer((port) => {
      prod = spawn('node', [join(root, 'serve.mjs')], {
        cwd: '/tmp',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: String(port),
          CASIMIR_SQLITE_PATH: join(root, '.void/casimir.sqlite'),
        },
      });
      return prod;
    }, 30_000);
    prodBase = server.base;
    const html = await (await fetch(prodBase)).text();
    expect(html, server.output()).toContain('browser record');
    expect(await (await fetch(prodBase + '/api/internal-binding')).json()).toEqual({
      visible: false,
    });
    const asset = html.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/);
    expect(asset).not.toBeNull();
    expect((await fetch(new URL(asset![1], prodBase))).status).toBe(200);
    expect(await (await fetch(`${prodBase}/api/dependency`)).json()).toEqual({
      count: 2,
      configured: true,
    });
  }, 120_000);

  it('rejects a private server value imported into a browser page', () => {
    const path = join(root, 'pages/private.tsx');
    writeFileSync(
      path,
      `import {env} from 'void/env';
export default function Private(){ return <p>{env.SERVER_ONLY}</p>; }`,
    );
    try {
      expect(() => run(['exec', 'vp', 'build'], root)).toThrow(/SERVER_ONLY|server.only|client/i);
    } finally {
      rmSync(path);
    }
  }, 120_000);
});
