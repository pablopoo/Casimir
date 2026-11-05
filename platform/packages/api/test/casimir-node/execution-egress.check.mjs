import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';
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
console.log('Actual runtime external DNS, HTTPS and direct-IP egress denied');
