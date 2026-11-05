import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const {Pool}=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url))('pg');
const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length);const pool=new Pool({connectionString});
test('recovery_required_startup_closes_ingress_and_never_starts_a_writer',async t=>{
 t.after(()=>pool.end());assert.equal(typeof checks.reconcileInstallationStartup,'function');let closed=0;
 const result=await checks.reconcileInstallationStartup({db:checks.createDb(pool),profile:{installationId:'1'.repeat(32)},guard:{assertLive(){}},engine:{async closeProxy(){closed++;},async startApp(){assert.fail('blocked writer started');}}});
 assert.equal(closed,1);assert.equal(result.outcome,'blocked');assert.equal(result.code,'recovery_required');
});
test('explicit_stopped_resume_proves_no_active_writer_before_ready',async()=>{
 let calls=0,proofs=0;const ctx={profile:{installationId:'1'.repeat(32)},guard:{assertLive(){}},engine:{async closeProxy(){},async assertSingleWriter(op){assert.equal(op,null);proofs++;}},routes:{async read(){return {target:null};}},db:{async execute(){calls++;return {rows:calls===1?[{installation_id:'1'.repeat(32),project_id:'p',phase:'stopped',bundle_version:'c1.0'}]:calls===2?[]:[{active_deployment_id:null}]};}}};
 const result=await checks.reconcileInstallationStartup(ctx,{resumeStopped:true});assert.equal(result.outcome,'ready');assert.equal(proofs,1);
});
