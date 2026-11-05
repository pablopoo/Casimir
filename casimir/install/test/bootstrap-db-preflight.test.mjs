import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBootstrapFixtureConfig } from './bootstrap-db-fixture.mjs';

const noFileRead = async () => {
  throw new Error('unexpected environment file read');
};

test('bootstrap database fixture refuses the old implicit default before reading an environment file', async () => {
  await assert.rejects(
    () => loadBootstrapFixtureConfig({}, noFileRead),
    /CASIMIR_C1_TEST_ENV_FILE/,
  );
});

test('bootstrap database fixture requires an explicit synthetic database selector', async () => {
  await assert.rejects(
    () => loadBootstrapFixtureConfig({ CASIMIR_C1_TEST_ENV_FILE: '/generated/test.env' }, async () => 'DATABASE_URL=postgres://user:secret@casimir-c1-source-test-db:5432/casimir_c1'),
    /CASIMIR_C1_BOOTSTRAP_TEST_DATABASE/,
  );
});

test('bootstrap database fixture rejects the protected shared endpoint before any database connection', async () => {
  await assert.rejects(
    () => loadBootstrapFixtureConfig({
      CASIMIR_C1_TEST_ENV_FILE: '/generated/test.env',
      CASIMIR_C1_BOOTSTRAP_TEST_DATABASE: 'casimir_c1_bootstrap_20261019_abcdef',
    }, async () => 'DATABASE_URL=postgres://user:secret@casimir-c1-test-db:5432/casimir_c1'),
    /isolated Docker network alias/,
  );
});

test('bootstrap database fixture refuses malformed synthetic database names', async () => {
  await assert.rejects(
    () => loadBootstrapFixtureConfig({
      CASIMIR_C1_TEST_ENV_FILE: '/generated/test.env',
      CASIMIR_C1_BOOTSTRAP_TEST_DATABASE: 'casimir_c1',
    }, noFileRead),
    /dated unique test name format/,
  );
});
