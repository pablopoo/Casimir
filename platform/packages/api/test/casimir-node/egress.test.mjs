import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { test } from 'node:test';

test('runtime denies external DNS, HTTPS and direct-IP egress without provider mocks', async () => {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  await assert.rejects(resolver.resolve4('api.cloudflare.com'));
  await assert.rejects(
    fetch('https://api.cloudflare.com/client/v4/', { signal: AbortSignal.timeout(3000) }),
  );
  const connected = await new Promise((resolve) => {
    const socket = connect({ host: '1.1.1.1', port: 443 });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
  assert.equal(connected, false);
  const provenance = JSON.parse(readFileSync('casimir/dist/provenance.json', 'utf8'));
  assert.ok(provenance.modules.length > 0);
  assert.ok(provenance.modules.some((p) => p.endsWith('/src/project-access.ts')));
  assert.ok(
    !provenance.modules.some((p) => p.includes('/__mocks__/') || p.startsWith('cloudflare:')),
  );
  assert.ok(!provenance.imports.some((p) => p.startsWith('cloudflare:')));
});
