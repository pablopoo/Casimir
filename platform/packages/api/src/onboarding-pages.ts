import { browserPageLead, escapeBrowserHtml, renderBrowserPage } from '@void/platform/browser-page';
import { platformConnectCommand } from './platform-identity.ts';

export function platformWelcomePage(platformName: string, apiUrl: string): string {
  const command = escapeBrowserHtml(platformConnectCommand(apiUrl));
  return renderBrowserPage({
    title: 'Welcome',
    platformName,
    content:
      browserPageLead(
        `Welcome to ${platformName}`,
        'This is a Void platform. Connect the Void CLI to deploy and manage your applications here.',
      ) +
      `<div class="void-auth-section">
<h2>Connect to this platform</h2>
<p>Install the Void CLI if you haven't already:</p>
<pre><code>npm install -g void</code></pre>
<p>From a new or unlinked Void app directory, connect to this platform:</p>
<pre><code>${command}</code></pre>
<p>The CLI opens your browser to sign in when needed. If access is restricted, ask your platform administrator for an invitation and sign in with the invited email address.</p>
</div>
<div class="void-auth-section">
<p>Ready to deploy? Run <code>void deploy</code> from your application's directory. To create a new application, follow the <a href="https://void.cloud/guide/quickstart">Void quickstart</a>, then connect it to this platform before deploying.</p>
</div>
<div class="void-auth-section">
<h2>Administration</h2>
<p>Platform administrators can manage this instance from the administrator dashboard.</p>
<a class="void-auth-button" href="/admin/">Open Admin Dashboard</a>
</div>`,
  });
}

export function platformInvitationPage(
  platformName: string,
  apiUrl: string,
  invitationId: string | null,
): string {
  const command = escapeBrowserHtml(platformConnectCommand(apiUrl));
  const invitationCommand = invitationId
    ? escapeBrowserHtml(`void project team accept ${invitationId}`)
    : null;
  return renderBrowserPage({
    title: invitationCommand ? 'Accept Project Invitation' : 'Get Started',
    platformName,
    content:
      browserPageLead(
        invitationCommand ? 'Accept your project invitation' : `Get Started with ${platformName}`,
        'Connect the Void CLI to this platform. When prompted, sign in with an account whose verified email address matches your invitation:',
      ) +
      `<pre><code>${command}</code></pre>
${
  invitationCommand
    ? `<div class="void-auth-section"><p>Then accept the project invitation. The CLI checks that it is still valid and addressed to your signed-in account:</p>
<pre><code>${invitationCommand}</code></pre></div>`
    : ''
}
<p>The CLI opens your browser to sign in when needed. Invitation commands use your connected platform account and can run from any directory.</p>
<p>To work on an application on this platform, open its directory and run <code>void project link</code> if it is not linked yet. If that directory is already linked to another project, use a separate checkout without a <code>.void/project.json</code> file, connect to this platform there, and run <code>void project link</code>. Accepting an invitation keeps existing project links.</p>
<p>Need to create an application? Read the <a href="https://void.cloud/guide/quickstart">Void quickstart</a>, then return here to connect to this platform before deploying.</p>`,
  });
}

export function platformRestrictedSignupPage(platformName: string): string {
  return renderBrowserPage({
    title: 'Signup Restricted',
    platformName,
    content:
      browserPageLead(
        'Signup Restricted',
        `New accounts on ${platformName} require administrator approval.`,
      ) +
      '<p>Ask your platform administrator for an invitation, then sign in with an account whose verified email address matches that invitation.</p>' +
      '<a class="void-auth-button" href="/">Back to welcome</a>',
  });
}
