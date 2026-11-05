import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
test('mounted runtime secret copy contains only declared app keys and rejects control bindings', () => {
  assert.equal(typeof checks.selectRuntimeSecrets, 'function');
  assert.deepEqual(
    checks.selectRuntimeSecrets(['SERVER_ONLY'], { SERVER_ONLY: 'test', OTHER_APP: 'excluded' }),
    { SERVER_ONLY: 'test' },
  );
  assert.throws(
    () => checks.selectRuntimeSecrets(['CASIMIR_TOKEN'], { CASIMIR_TOKEN: 'wrong' }),
    /runtime_env/,
  );
  assert.throws(
    () => checks.selectRuntimeSecrets(['NODE_OPTIONS'], { NODE_OPTIONS: '--require evil' }),
    /runtime_env/,
  );
});
