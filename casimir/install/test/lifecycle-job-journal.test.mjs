import {test} from 'node:test';import assert from 'node:assert/strict';
const api=await import('../../../platform/packages/api/src/casimir/lifecycle/job-journal.ts').catch(()=>({}));
test('lifecycle jobs preserve existing route and job records and reject conflicting retries',()=>{
 assert.equal(typeof api.appendLifecycleJob,'function');const old={route:null,previousOperationId:null,jobs:{existing:{id:'old'}}},record={id:'a'.repeat(32),action:'backup',releaseId:'cmv_123456789012',parameters:{path:'/data/app.sqlite',destination:'/snapshots/a.sqlite'}};
 const next=api.appendLifecycleJob(old,record);assert.deepEqual(next.route,null);assert.deepEqual(next.jobs.existing,{id:'old'});assert.deepEqual(next.jobs['lifecycle-'+record.id],record);assert.deepEqual(api.appendLifecycleJob(next,record),next);assert.throws(()=>api.appendLifecycleJob(next,{...record,action:'restore'}),/lifecycle_job_conflict/);assert.deepEqual(old.jobs,{existing:{id:'old'}});
});
