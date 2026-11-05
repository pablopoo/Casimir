import {test} from 'node:test';import assert from 'node:assert/strict';import * as checks from '../../dist/checks.mjs';
test('read_only_ingress_inspection_does_not_require_or_bypass_mutation_guard',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let requests=0;globalThis.fetch=async()=>{requests++;return new Response('',{status:503});};
 const engine=new checks.MvpEngine({socketPath:'/unused',runnerImage:'sha256:'+'a'.repeat(64),runtime:{},installationId:'1'.repeat(32)});
 await engine.inspectIngress(null);assert.equal(requests,1);await assert.rejects(()=>engine.observeIngress(null),/executor_guard_required/);assert.equal(requests,1);
});
