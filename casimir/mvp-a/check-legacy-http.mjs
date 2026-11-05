import { spawnSync } from 'node:child_process';
import { withMvpControl } from '../../platform/packages/api/test/casimir-node/mvp-support.mjs';
await withMvpControl(async ({ env }) => {
  const legacyEnv = { ...env };
  delete legacyEnv.CASIMIR_MVP_PROFILE;
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=60000', 'platform/packages/api/test/casimir-node/http.test.mjs'],
    { env: legacyEnv, stdio: 'inherit', timeout: 90000 },
  );
  if (result.status !== 0) {
    throw new Error('legacy HTTP checks failed');
  }
});
