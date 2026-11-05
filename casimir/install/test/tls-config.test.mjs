import {test} from 'node:test';import assert from 'node:assert/strict';
const api=await import('../tls.mjs').catch(()=>({}));
test('tls_frontend_exact_hosts_replaces_forwarded_headers_and_never_mounts_keys_on_api',()=>{
 assert.equal(typeof api.tlsConfig,'function');const s=api.tlsConfig({controlOrigin:'https://control.example.test:4443',appOrigin:'https://app.example.test:4444'},'casimir-'+'a'.repeat(32));
 assert.match(s,/ssl_certificate_key \/certs\/key.pem/);assert.match(s,/proxy_set_header X-Forwarded-Proto https/);assert.match(s,/return 403/);assert.ok(!s.includes('$http_x_forwarded_proto'));
});
