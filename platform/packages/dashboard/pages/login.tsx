import { browserPageLogo, browserPageStyles } from '@void/platform/browser-page';
import type { Props } from './login.server.ts';

export default function LoginPage({ methods, platformName, unavailable, devLoginUrl }: Props) {
  return (
    <main className="void-auth-page">
      <style>{browserPageStyles}</style>
      <div className="void-auth-container">
        <div className="void-auth-brand">
          <span className="void-auth-logo" dangerouslySetInnerHTML={{ __html: browserPageLogo }} />
          <span className="void-auth-divider" aria-hidden="true" />
          <span>{platformName}</span>
        </div>
        <section className="void-auth-card" aria-labelledby="void-auth-title">
          <div className="void-auth-lead">
            <h1 id="void-auth-title">Sign in to {platformName}</h1>
            <p>Access your projects and deployments.</p>
          </div>
          <div className="void-auth-actions">
            {methods.map((method, index) => (
              <a
                key={method.id}
                className={
                  index === 0 ? 'void-auth-button void-auth-button-primary' : 'void-auth-button'
                }
                href={method.url}
              >
                Continue with {method.label}
              </a>
            ))}
          </div>
          {(unavailable || methods.length === 0) && (
            <div className="void-auth-actions">
              <p>
                Login is temporarily unavailable. Try again shortly or contact your platform
                administrator.
              </p>
              <a className="void-auth-button void-auth-button-primary" href="/login">
                Try again
              </a>
            </div>
          )}
          {devLoginUrl && (
            <div className="void-auth-actions">
              <a className="void-auth-button" href={devLoginUrl}>
                Dev login (local API)
              </a>
              <p className="void-auth-note">
                Local-development bypass. Requires <code>DEV_AUTH_BYPASS=true</code> on the API.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
