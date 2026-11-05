import assert from 'node:assert/strict';
import { test } from 'node:test';

test('preserved project slug policy rejects malformed, reserved and oversized names', async () => {
  const { validateProjectSlug } = await import('../../../../../casimir/dist/checks.mjs');
  for (const slug of [
    undefined,
    null,
    4,
    {},
    '',
    'UPPERCASE',
    '-name',
    'name-',
    'a.b',
    'admin',
    'noreply',
    'preview-demo',
    'a'.repeat(57),
  ]) {
    assert.equal(typeof validateProjectSlug(slug), 'string', `must reject ${JSON.stringify(slug)}`);
  }
  for (const slug of ['casimir-demo', 'a'.repeat(56), 'a', 'a-b'])
    assert.equal(validateProjectSlug(slug), null);
});
