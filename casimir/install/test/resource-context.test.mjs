import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MvpEngine} from '../../dist/checks.mjs';
const runtime={protocol:1,profile:'node-sqlite-v1',sdkVersion:'1.1.11',runtimeId:'a'.repeat(64),platform:'linux/amd64',nodeAbi:'137'};
const op={id:'cmv_'+'a'.repeat(12),project_id:'proj_'+'b'.repeat(12),artifact_id:'car_'+'c'.repeat(12),deployment_id:'dpl_'+'d'.repeat(12),image_id:'sha256:'+'e'.repeat(64),runtime};
test('trusted_installation_context_scopes_every_app_and_job_mount',()=>{
 const id='1'.repeat(32),engine=new MvpEngine({socketPath:'/unused',runnerImage:'sha256:'+'b'.repeat(64),runtime,installationId:id});
 const app=engine.containerBody(op);assert.equal(app.HostConfig.NetworkMode,`casimir-${id}-apps`);assert.equal(app.Labels['org.casimir.installation'],id);assert.equal(app.HostConfig.RestartPolicy.Name,'no');
 assert.ok(app.HostConfig.Mounts.every(m=>m.Source.startsWith(`casimir-${id}-`)));
 const job=engine.jobBody(op,'state','f'.repeat(32));assert.ok(job.HostConfig.Mounts.every(m=>m.Source.startsWith(`casimir-${id}-`)));
 assert.equal(job.HostConfig.NetworkMode,'none');
});
