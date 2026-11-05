import { browserPageLead, browserPageStatus } from '@void/platform/browser-page';
import type { Context } from 'hono';
import { platformBrowserPage } from '../../browser-page.ts';
import type { PlatformManagementEnv } from '../../env.ts';

export function adminAccessRejected<E extends PlatformManagementEnv>(
  context: Context<E>,
  reason: 'required' | 'suspended',
): Response {
  const suspended = reason === 'suspended';
  const title = suspended ? 'Administrator access suspended' : 'Administrator access required';
  const message = suspended
    ? 'Contact another platform administrator to restore access.'
    : 'Sign in with an administrator account for this platform.';
  return platformBrowserPage(
    context,
    title,
    browserPageStatus('error') +
      browserPageLead(title, message) +
      '<a class="void-auth-button void-auth-button-primary" href="/admin/logout">Sign in with another account</a>',
    403,
  );
}

export function adminRequestRejected<E extends PlatformManagementEnv>(
  context: Context<E>,
  error: string,
  format: 'json' | 'text',
): Response {
  const message = 'Refresh the dashboard and try again.';
  if (context.req.header('Accept')?.includes('text/html')) {
    return platformBrowserPage(
      context,
      'Request could not be verified',
      browserPageStatus('error') +
        browserPageLead('Request could not be verified', message) +
        '<a class="void-auth-button void-auth-button-primary" href="/admin/">Refresh dashboard</a>',
      403,
    );
  }
  return format === 'json'
    ? context.json({ error, message }, 403)
    : context.text(`${error} ${message}`, 403);
}
