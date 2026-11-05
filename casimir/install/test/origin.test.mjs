import {test} from 'node:test';import assert from 'node:assert/strict';import {runtimeFetch} from '../../mvp-a/runner/bootstrap.mjs';
const release={projectId:'proj_'+'a'.repeat(12),deploymentId:'dpl_'+'b'.repeat(12),artifactId:'car_'+'c'.repeat(12),origin:'https://app.example.test:4443'};
test('trusted_operator_origin_rewrites_transport_scheme_and_rejects_forged_host_origin',async()=>{
 const handle=runtimeFetch({fetch:request=>Response.json({url:request.url})},release);
 const r=await handle(new Request('http://app.example.test:4443/api',{headers:{Origin:release.origin,'X-Forwarded-Proto':'http'}}));assert.equal((await r.json()).url,release.origin+'/api');
 for(const request of [new Request('http://attacker.test/api'),new Request('http://app.example.test:4443/api',{method:'POST',headers:{Origin:'https://attacker.test'}})])assert.equal((await handle(request)).status,403);
});
