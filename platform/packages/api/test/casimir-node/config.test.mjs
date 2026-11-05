import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('startup configuration is explicit and rejects incomplete or invalid values', async () => {
  const { loadConfig } = await import('../../../../../casimir/dist/checks.mjs');
  const valid = {
    DATABASE_URL: 'postgresql://fake:fake@db/fake',
    CASIMIR_TOKEN: 'fictional-test-token',
    CASIMIR_OPERATOR_ID: 'casimir_operator',
    PORT: '4281',
  };
  assert.equal(loadConfig(valid).port, 4281);
  for (const env of [
    {},
    { ...valid, CASIMIR_TOKEN: '' },
    { ...valid, CASIMIR_TOKEN: ' ' },
    { ...valid, DATABASE_URL: 'https://example.invalid' },
    { ...valid, DATABASE_URL: 'postgresql:garbage' },
    { ...valid, DATABASE_URL: 'postgresql:' },
    { ...valid, DATABASE_URL: 'postgresql://db' },
    { ...valid, PORT: '0' },
    { ...valid, PORT: '65536' },
    { ...valid, PORT: '42oops' },
    { ...valid, CASIMIR_OPERATOR_ID: '' },
  ]) {
    assert.throws(() => loadConfig(env), /configuration/i);
  }
});

test('compiled startup refuses incomplete database URLs without listening or logging tokens', () => {
  const syntheticToken = 'fictional-token-must-not-be-logged';
  for (const databaseUrl of ['postgresql:garbage', 'postgresql:', 'postgresql://db']) {
    const child = spawnSync(process.execPath, ['casimir/dist/main.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CASIMIR_TOKEN: syntheticToken,
        PORT: '4293',
      },
      encoding: 'utf8',
      timeout: 2500,
    });
    assert.equal(child.status, 1, 'invalid configuration must exit nonzero immediately');
    const output = child.stdout + child.stderr;
    assert.ok(!output.includes('listening'));
    assert.ok(!output.includes(syntheticToken));
    assert.match(output, /configuration invalid/i);
  }
});
