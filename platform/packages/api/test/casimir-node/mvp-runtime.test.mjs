import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('fixed runtime reserves identity and supplies declared private env without process.env', async () => {
  const runtime = await import(pathToFileURL(resolve('casimir/mvp-a/runner/bootstrap.mjs')).href);
  const release = {
    projectId: 'proj_' + 'a'.repeat(12),
    deploymentId: 'dpl_' + 'b'.repeat(12),
    artifactId: 'car_' + 'c'.repeat(12),
  };
  const app = { fetch: async (req) => new Response('app:' + new URL(req.url).pathname) };
  const fetch = runtime.runtimeFetch(app, release);
  assert.deepEqual(
    await (await fetch(new Request('http://app/_casimir/identity'))).json(),
    release,
  );
  assert.equal((await fetch(new Request('http://app/_casimir/anything'))).status, 404);
  assert.equal((await fetch(new Request('http://app/notes'))).status, 200);
  assert.deepEqual(
    runtime.startupEnv(['SERVER_ONLY'], { SERVER_ONLY: 'private', UNDECLARED: 'hidden' }),
    { SERVER_ONLY: 'private', CASIMIR_SQLITE_PATH: '/data/app.sqlite' },
  );
  assert.throws(
    () => runtime.startupEnv(['CASIMIR_TOKEN'], { CASIMIR_TOKEN: 'wrong' }),
    /runtime_env/,
  );
  assert.equal(process.env.SERVER_ONLY, undefined);
});
