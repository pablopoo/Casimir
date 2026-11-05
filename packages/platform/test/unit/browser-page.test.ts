import { describe, expect, it } from 'vite-plus/test';
import { browserPageIdentity, browserPageLead, renderBrowserPage } from '../../src/browser-page.ts';

describe('browser authentication pages', () => {
  it('uses the original Void identity by default and Casimir identity only for its profile', () => {
    const upstream = renderBrowserPage({
      title: 'Set up administrator',
      platformName: 'Void Platform',
      content: '<p>setup</p>',
    });
    expect(upstream).toContain('<title>Set up administrator · Void Platform</title>');
    expect(upstream).toContain('aria-label="Void"');
    expect(upstream).not.toContain('casimir-mark.svg');

    const casimir = renderBrowserPage({
      title: 'Set up administrator',
      platformName: 'Casimir',
      branding: 'casimir',
      content: '<p>setup</p>',
    });
    expect(casimir).toContain('<title>Set up administrator · Casimir</title>');
    expect(casimir).toContain('<link rel="icon" href="/admin/casimir-mark.svg"');
    expect(casimir).toContain('aria-label="Casimir mark"');
    expect(casimir).toContain('<span>Casimir</span></span>');
    expect(casimir).not.toContain('aria-label="Void"');
  });

  it('escapes platform branding, titles, and descriptions from configuration', () => {
    const untrusted = '<script>alert("owner")</script>&';
    const page = renderBrowserPage({
      title: untrusted,
      platformName: untrusted,
      content: browserPageLead(untrusted, untrusted),
    });
    expect(page).not.toContain(untrusted);
    expect(page).toContain('&lt;script&gt;');
    expect(page).toContain('&quot;owner&quot;');
    expect(page).toContain('&amp;');
  });
  it('shows all identity security fields while escaping provider input', () => {
    const identity = browserPageIdentity({
      login: '<img src=x onerror=alert(1)>',
      issuer: 'https://company.example.com/?tenant=<test>',
      subject: '123"</dd><script>x</script>',
    });
    expect(identity).toContain('https://company.example.com/?tenant=&lt;test&gt;');
    expect(identity).toContain('123&quot;&lt;/dd&gt;');
    expect(identity).not.toContain('<script>');
    expect(identity).not.toContain('<img');
  });
});
