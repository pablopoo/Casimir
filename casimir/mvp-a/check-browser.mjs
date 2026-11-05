import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/playwright';
const { chromium } = await import('playwright');
const app = 'http://casimir-mvp-a-app-ingress:8080';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const external = [];
  if (process.env.CASIMIR_TEST_DEBUG === '1') {
    page.on('console', (message) =>
      console.log('browser console:', message.type(), message.text()),
    );
  }
  page.on('pageerror', (error) => console.log('browser exception:', error.message));
  if (process.env.CASIMIR_TEST_DEBUG === '1') {
    page.on('response', async (response) => {
      console.log('browser response:', response.status(), new URL(response.url()).pathname);
    });
  }
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== app) {
      external.push(request.url());
    }
  });
  await page.goto(app);
  await page.getByRole('textbox', { name: 'Message' }).fill('casimir deployed browser record');
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  await page.getByRole('button', { name: 'Save' }).click();
  const submission = await posted;
  try {
    await page
      .getByRole('listitem')
      .filter({ hasText: 'casimir deployed browser record' })
      .first()
      .waitFor();
  } catch (error) {
    console.log('browser body:', await page.locator('body').innerText());
    await page.screenshot({ path: '.local/mvp-a/browser-failed.png' });
    throw error;
  }
  assert.equal(external.length, 0);
  const rows = await (await fetch(app + '/api/messages')).json();
  assert.ok(rows.messages.some((row) => row.text === 'casimir deployed browser record'));
  const headers = await submission.allHeaders();
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  headers.origin = 'http://foreign.invalid';
  const forged = await fetch(app + '/', {
    method: 'POST',
    headers,
    body: submission.postDataBuffer(),
  });
  assert.equal(forged.status, 403);
  assert.equal(
    (await (await fetch(app + '/api/messages')).json()).messages.length,
    rows.messages.length,
  );
  console.log(
    'Real deployed Chromium form/action/readback and forged-origin rejection pass without external browser requests',
  );
} finally {
  await browser.close();
}
