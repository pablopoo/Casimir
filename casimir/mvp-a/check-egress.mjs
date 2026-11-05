import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
const resolver = new Resolver({ timeout: 500, tries: 1 });
resolver.setServers(['1.1.1.1']);
await assert.rejects(resolver.resolve4('example.com'));
for (const url of ['https://example.com', 'https://1.1.1.1']) {
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
}
console.log('External DNS/HTTPS/direct-IP connections denied');
