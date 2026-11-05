import { test } from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../../../platform/packages/api/src/casimir/lifecycle/config.ts').catch(()=>({}));
const value={format:1,mode:'loopback',controlOrigin:'http://127.0.0.1:4485',appOrigin:'http://127.0.0.1:4486',bindAddress:'127.0.0.1',controlPort:4485,appPort:4486};
test('loopback_mode_rejects_remote_origins_and_command_fields',()=>{
 assert.equal(typeof api.parseInstallConfig,'function');assert.deepEqual(api.parseInstallConfig(value),value);
 for(const bad of [{...value,bindAddress:'0.0.0.0'},{...value,controlOrigin:'http://example.test:4485'},{...value,command:'sh'},{...value,controlOrigin:'http://127.0.0.1:4485/path'},{...value,appPort:4485}]) assert.throws(()=>api.parseInstallConfig(bad));
});
test('tls_requires_distinct_exact_secure_origins_and_operator_certificate_paths',()=>{
 const v={...value,mode:'tls',bindAddress:'10.0.0.1',controlOrigin:'https://control.example.test:4485',appOrigin:'https://app.example.test:4486',certificatePaths:{certificate:'/state/cert.pem',key:'/state/key.pem',ca:'/state/ca.pem'}};
 assert.deepEqual(api.parseInstallConfig(v),v);assert.throws(()=>api.parseInstallConfig({...v,appOrigin:v.controlOrigin}));assert.throws(()=>api.parseInstallConfig({...v,certificatePaths:{...v.certificatePaths,key:'../key'}}));
 assert.throws(()=>api.parseInstallConfig({...v,mode:'external-tls',bindAddress:'0.0.0.0'}));
});
test('external_tls_accepts_only_ca_and_loopback_backends_without_proxy_private_key',()=>{
 const external={...value,mode:'external-tls',controlOrigin:'https://control.example.test:4443',appOrigin:'https://app.example.test:4444',certificatePaths:{ca:'/private/ca.pem'}};
 assert.deepEqual(api.parseInstallConfig(external),external);
 assert.throws(()=>api.parseInstallConfig({...external,certificatePaths:{...external.certificatePaths,key:'/private/proxy.key',certificate:'/private/proxy.pem'}}));
 assert.throws(()=>api.parseInstallConfig({...external,bindAddress:'0.0.0.0'}));
});
