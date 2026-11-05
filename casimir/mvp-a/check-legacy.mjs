import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withMvpControl } from '../../platform/packages/api/test/casimir-node/mvp-support.mjs';
// Fresh randomly named fixture databases on this experiment's dedicated PG.
// No retained legacy PoC service, catalog or volume is opened.
function run(files, env) {
  const legacy = { ...env };
  delete legacy.CASIMIR_MVP_PROFILE;
  delete legacy.CASIMIR_EXECUTION_PROFILE;
  delete legacy.API_BASE_URL;
  delete legacy.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...files.map((file) => 'platform/packages/api/test/casimir-node/' + file + '.test.mjs'),
    ],
    { env: legacy, stdio: 'inherit', timeout: 180000 },
  );
  assert.equal(result.status, 0);
}
await withMvpControl(async ({ env }) => run(['http'], env));
// Execution fixtures own port4289 themselves, after the outer fixture is closed.
run(
  [
    'config',
    'execution-profile',
    'execution-docker',
    'execution-guard',
    'execution-admission',
    'execution-fixture',
  ],
  process.env,
);
