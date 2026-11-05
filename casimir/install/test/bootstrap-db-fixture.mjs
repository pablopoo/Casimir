import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bootstrapDatabasePattern = /^casimir_c1_bootstrap_\d{8}_[a-f0-9]{6}$/;
const requiredHost = 'casimir-c1-source-test-db';

export async function loadBootstrapFixtureConfig(env = process.env, read = readFile) {
  assert.ok(
    env.CASIMIR_C1_TEST_ENV_FILE,
    'CASIMIR_C1_TEST_ENV_FILE must name the generated disposable-test environment file',
  );
  assert.ok(
    env.CASIMIR_C1_BOOTSTRAP_TEST_DATABASE,
    'CASIMIR_C1_BOOTSTRAP_TEST_DATABASE must name a fresh disposable database',
  );
  assert.match(
    env.CASIMIR_C1_BOOTSTRAP_TEST_DATABASE,
    bootstrapDatabasePattern,
    'bootstrap database must use the dated unique test name format',
  );

  const contents = await read(env.CASIMIR_C1_TEST_ENV_FILE, 'utf8');
  const databaseLines = contents
    .split(/\r?\n/)
    .filter((line) => line.startsWith('DATABASE_URL='));
  assert.equal(databaseLines.length, 1, 'generated test environment must contain one DATABASE_URL');

  let baseUrl;
  try {
    baseUrl = new URL(databaseLines[0].slice('DATABASE_URL='.length));
  } catch {
    throw new Error('generated test DATABASE_URL is invalid');
  }
  assert.ok(
    ['postgres:', 'postgresql:'].includes(baseUrl.protocol),
    'bootstrap test requires a PostgreSQL DATABASE_URL',
  );
  assert.equal(baseUrl.hostname, requiredHost, 'bootstrap test requires its isolated Docker network alias');
  assert.equal(baseUrl.port, '5432', 'bootstrap test requires PostgreSQL port 5432');
  assert.equal(baseUrl.pathname, '/casimir_c1', 'generated test DATABASE_URL must select /casimir_c1');
  assert.ok(baseUrl.username, 'generated test DATABASE_URL must name its PostgreSQL role');

  const bootstrapUrl = new URL(baseUrl);
  bootstrapUrl.pathname = `/${env.CASIMIR_C1_BOOTSTRAP_TEST_DATABASE}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  return {
    adminConnectionString: adminUrl.toString(),
    bootstrapConnectionString: bootstrapUrl.toString(),
    databaseName: env.CASIMIR_C1_BOOTSTRAP_TEST_DATABASE,
    roleName: decodeURIComponent(baseUrl.username),
  };
}
