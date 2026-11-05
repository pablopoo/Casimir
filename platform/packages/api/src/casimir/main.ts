import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { Pool } from 'pg';
import { createDb } from '../db/client.ts';
import { canonicalOriginHostname, createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { loadProfile } from './execution/profile.ts';
import { loadMvpProfile } from './mvp/profile.ts';
import { readCasimirManagementConfig } from './management/management-files.ts';
import { probeLocalApiHealth } from './management/api-health.ts';

function managementSetupStatePath(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined;
  if (!encoded || encoded.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Casimir auth setup state is invalid');
  }
  let state: string;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('base64_not_canonical');
    state = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Casimir auth setup state is invalid');
  }
  if (
    !isAbsolute(state) ||
    resolve(state) !== state ||
    normalize(state) !== state ||
    /[\0\r\n,]/.test(state)
  ) {
    throw new Error('Casimir auth setup state is invalid');
  }
  return state;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

try {
  const config = loadConfig(process.env);
  const profile = process.env.CASIMIR_EXECUTION_PROFILE
    ? loadProfile(process.env.CASIMIR_EXECUTION_PROFILE)
    : undefined;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    statement_timeout: 5000,
    max: 5,
  });
  pool.on('error', () => {
    console.error('Casimir database connection unavailable');
  });
  const db = createDb(pool);
  const mvpProfile = process.env.CASIMIR_MVP_PROFILE
    ? loadMvpProfile(process.env.CASIMIR_MVP_PROFILE)
    : undefined;
  const managementActivation = process.env.CASIMIR_MANAGEMENT_ENABLED;
  if (managementActivation !== undefined && !['true', 'false'].includes(managementActivation)) {
    throw new Error('CASIMIR_MANAGEMENT_ENABLED must be true or false');
  }
  const managementEnabled = managementActivation === 'true';
  const managementSetupState = managementSetupStatePath(process.env.CASIMIR_AUTH_SETUP_STATE_B64);
  const managementConfigPath = process.env.CASIMIR_MANAGEMENT_CONFIG;
  if (managementEnabled && !managementConfigPath) {
    throw new Error('Casimir management activation requires a management config and profile');
  }
  if (managementEnabled && !managementSetupState) {
    throw new Error('Casimir management activation requires its auth setup state');
  }
  const managementConfig = managementEnabled && managementConfigPath
    ? await readCasimirManagementConfig(managementConfigPath)
    : undefined;
  const managementOrigin = mvpProfile?.origins?.control;
  if (managementEnabled && (!managementConfig || !mvpProfile?.origins || !managementOrigin)) {
    throw new Error('Casimir management activation requires a management config and profile');
  }
  if (managementEnabled && new URL(managementOrigin!).protocol !== 'https:') {
    throw new Error('Casimir management activation requires an HTTPS control origin');
  }
  if (
    managementEnabled &&
    canonicalOriginHostname(managementOrigin!) === canonicalOriginHostname(mvpProfile!.origins!.app)
  ) {
    throw new Error('Casimir management activation requires distinct control and app hostnames');
  }
  if (
    managementConfig &&
    (managementConfig.operatorId !== config.operatorId ||
      managementConfig.installationId !== mvpProfile?.installationId)
  ) {
    throw new Error('Casimir management profile identity mismatch');
  }
  // Original administrator cookies are Secure and CSRF checks the public
  // origin. The HTTP-only loopback profile remains CLI-only until TLS exists.
  const management =
    managementEnabled && managementConfig && managementOrigin?.startsWith('https://')
      ? {
          config: managementConfig,
          controlOrigin: managementOrigin,
          authSetupCommand: `casimir auth-setup --state ${shellQuote(managementSetupState!)}`,
          apiHealthProbe: () => probeLocalApiHealth(config.port),
          assets: {
            clientJs: readFileSync(new URL('./admin/client.js', import.meta.url)),
            styleCss: readFileSync(new URL('./admin/style.css', import.meta.url)),
          },
        }
      : undefined;
  if (profile && mvpProfile) {
    throw new Error('profiles are independent');
  }
  const app = createApp({
    db,
    token: config.token,
    operatorId: config.operatorId,
    profile,
    mvpProfile,
    management,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, () =>
    console.log('Casimir control listening'),
  );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 8000);
    deadline.unref();
    server.close(() => {
      void (async () => {
        try {
          await app.close();
        } catch {
          // Pool shutdown still runs if an identity dispatcher fails to close.
        }
        try {
          await pool.end();
        } catch {
          // The bounded shutdown deadline remains the final failure bound.
        } finally {
          clearTimeout(deadline);
        }
      })();
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safeActivationErrors = new Set([
    'CASIMIR_MANAGEMENT_ENABLED must be true or false',
    'Casimir management activation requires a management config and profile',
    'Casimir management activation requires an HTTPS control origin',
    'Casimir management activation requires distinct control and app hostnames',
    'Casimir management activation requires its auth setup state',
    'Casimir auth setup state is invalid',
  ]);
  console.error(safeActivationErrors.has(message) ? message : 'Casimir configuration invalid');
  process.exitCode = 1;
}
