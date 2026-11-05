import { Hono } from 'hono';
import type { Db } from '../../db/client.ts';
import type { CasimirManagementConfig } from './enrollment.ts';
import { createCasimirBootstrapOptions } from './bootstrap-policy.ts';
import { isCasimirManagementRequest, createCasimirManagementRequestHandler } from './origin-boundary.ts';
import type { PlatformManagementEnv } from '../../env.ts';
import { adminAuthMiddleware } from '../../admin/middleware/auth.ts';
import { adminCsrfMiddleware } from '../../admin/middleware/csrf.ts';
import {
  createManagementProjectsFateServer,
  type ManagementApiHealthProbe,
} from '../../admin/fate/projects-server.ts';
import { renderFateProjectsPage } from '../../admin/fate/render-projects-page.ts';
import { renderFateProjectDetailPage } from '../../admin/fate/render-project-detail-page.ts';
import { renderFateDeploymentsPage } from '../../admin/fate/render-deployments-page.ts';
import { renderFateDeploymentDetailPage } from '../../admin/fate/render-deployment-detail-page.ts';
import { renderDashboardFatePageWith } from '../../admin/fate/render-dashboard-page.ts';
import { createAdminLoginRoutes } from '../../admin/routes/login.ts';
import {
  completePlatformLogin,
  createPlatformIdentityRuntime,
  type PlatformIdentityRuntime,
} from '../../auth/login.ts';
import { createPlatformBootstrapRoutes } from '../../routes/platform-bootstrap.ts';
import { createIdentityTransport } from './identity-transport.ts';

type RequestDispatcher = (request: Request) => Response | Promise<Response>;
export type CasimirManagementFetchHandler = RequestDispatcher & {
  close(): Promise<void>;
};
export type CasimirAdminAssets = Readonly<{ clientJs: Uint8Array; styleCss: Uint8Array }>;

const CASIMIR_CAPABILITIES = JSON.stringify({
  ai: false,
  customDomains: false,
  email: false,
  githubActions: false,
  githubOAuth: false,
  googleOAuth: false,
  managedBuilds: false,
  sandbox: false,
});

const CASIMIR_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="none" stroke="#171717" stroke-width="4"/><path d="M43 20a16 16 0 1 0 0 24" fill="none" stroke="#171717" stroke-linecap="round" stroke-width="5"/></svg>';

export function createCasimirManagementBindings(
  config: CasimirManagementConfig,
  controlOrigin: string,
  appOrigin: string,
): PlatformManagementEnv['Bindings'] {
  return {
    AUTH_REDIRECT_URI: new URL('/auth/callback', controlOrigin).href,
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    JWT_SECRET: config.jwtSecret,
    PLATFORM_AUTH_DATABASE_UNCACHED: 'true',
    PLATFORM_AUTH_SETUP_TOKEN: config.authSetupToken,
    PLATFORM_CAPABILITIES: CASIMIR_CAPABILITIES,
    PLATFORM_BRANDING: 'casimir',
    PLATFORM_DISPLAY_NAME: 'Casimir',
    PLATFORM_ENV: 'production',
    PLATFORM_INSTALLATION_ID: config.installationId,
    SITE_DOMAIN: new URL(appOrigin).host,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: config.projectSecretActiveKeyVersion,
    PROJECT_SECRET_KEYS_JSON: config.projectSecretKeysJson,
  };
}

/** Mounts original Void browser auth routes for the owned Casimir installation. */
export function createCasimirManagementFetchHandler(input: {
  db: Db;
  config: CasimirManagementConfig;
  controlOrigin: string;
  appOrigin: string;
  authSetupCommand?: string;
  assets: CasimirAdminAssets;
  dispatch: RequestDispatcher;
  apiHealthProbe?: ManagementApiHealthProbe;
}): CasimirManagementFetchHandler {
  const identityRuntime: PlatformIdentityRuntime = createPlatformIdentityRuntime(
    createIdentityTransport(input.config.identityNetwork),
  );
  const bootstrapOptions = createCasimirBootstrapOptions(input.config);
  const bindings = createCasimirManagementBindings(input.config, input.controlOrigin, input.appOrigin);
  const appOrigin = new URL(input.appOrigin).origin;
  const projectUrlFor = (project: { id: string }) =>
    project.id === input.config.projectId ? appOrigin : null;
  const projectsFateServer = createManagementProjectsFateServer(
    projectUrlFor,
    projectUrlFor,
    input.apiHealthProbe,
  );
  const management = new Hono<PlatformManagementEnv>();

  management.get(
    '/admin/casimir-mark.svg',
    () =>
      new Response(CASIMIR_MARK_SVG, {
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      }),
  );

  management.use('*', async (context, next) => {
    context.set('db', input.db);
    await next();
  });
  management.use('*', async (context, next) => {
    await next();
    if (context.res.headers.get('Content-Type')?.startsWith('text/html')) {
      context.header('X-Frame-Options', 'DENY');
      context.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
  });

  management.route(
    '/',
    createPlatformBootstrapRoutes(bootstrapOptions, identityRuntime, {
      ...(input.authSetupCommand ? { expiredSetupCommand: input.authSetupCommand } : {}),
    }),
  );
  management.route('/admin', createAdminLoginRoutes(identityRuntime));
  management.get('/admin', (context) =>
    context.redirect(`/admin/${new URL(context.req.url).search}`, 308),
  );
  management.get('/admin/client.js', () =>
    new Response(Buffer.from(input.assets.clientJs), {
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/javascript; charset=utf-8' },
    }),
  );
  management.get('/admin/style.css', () =>
    new Response(Buffer.from(input.assets.styleCss), {
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'text/css; charset=utf-8' },
    }),
  );
  management.use('/admin/*', adminAuthMiddleware);
  management.use('/admin/*', adminCsrfMiddleware);
  management.post('/admin/fate', (context) =>
    projectsFateServer.handleRequest(context.req.raw, context),
  );
  management.get('/admin/', (context) =>
    renderDashboardFatePageWith(context, (request, currentContext) =>
      projectsFateServer.handleRequest(request, currentContext),
    ),
  );
  management.get('/admin/projects', (context) =>
    renderFateProjectsPage(context, (request, currentContext) =>
      projectsFateServer.handleRequest(request, currentContext),
    ),
  );
  management.get('/admin/projects/:id', (context) =>
    renderFateProjectDetailPage(context, (request, currentContext) =>
      projectsFateServer.handleRequest(request, currentContext),
    ),
  );
  management.get('/admin/deployments', (context) =>
    renderFateDeploymentsPage(context, (request, currentContext) =>
      projectsFateServer.handleRequest(request, currentContext),
    ),
  );
  management.get('/admin/deployments/:id', (context) =>
    renderFateDeploymentDetailPage(context, (request, currentContext) =>
      projectsFateServer.handleRequest(request, currentContext),
    ),
  );
  management.use('/auth/callback', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  management.get('/auth/callback', async (context) => {
    if (!context.req.query('state')?.startsWith('platform.')) {
      return context.json({ error: 'managed_login_required' }, 400);
    }
    return completePlatformLogin(context, {
      bootstrapOptions,
      existingIdentityOnly: true,
      identityRuntime,
    });
  });

  const dispatch = createCasimirManagementRequestHandler(input.controlOrigin, (request) => {
    if (isCasimirManagementRequest(request)) return management.fetch(request, bindings);
    return input.dispatch(request);
  });
  return Object.assign(dispatch, {
    close: () => identityRuntime.close(),
  });
}
