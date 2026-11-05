import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const urls = ['http://api:4281/health'];
if (process.argv[2] === 'app') urls.push('http://app-ingress:8080/health');
for (const url of urls) {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, 'bounded readiness ' + url);
}
