import assert from 'node:assert/strict';
import { test } from 'node:test';
test('database outage returns unavailable readiness and never a management success', async () => {
  const base = process.env.API_BASE_URL ?? 'http://api:4281';
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 503);
  const management = await fetch(base + '/projects', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CASIMIR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ slug: 'casimir-outage' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(management.status, 503);
  const output = await management.text();
  assert.ok(!output.includes(process.env.CASIMIR_TOKEN));
  assert.ok(!output.includes(process.env.DATABASE_URL));
});
