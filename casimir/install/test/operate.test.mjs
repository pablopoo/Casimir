import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';import {join} from 'node:path';
import {operate} from '../operate.mjs';import {deriveResources} from '../../../platform/packages/api/src/casimir/lifecycle/resources.ts';
test('operator_refuses_unknown_and_blocked_state_without_mutating_docker',async t=>{
 const root=await mkdtemp('/tmp/c1-operate-'),state=join(root,'state'),bin=join(root,'bin'),log=join(root,'calls');t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(()=>operate(state,'status'),{code:'ENOENT'});await assert.rejects(()=>stat(state),{code:'ENOENT'});
 await mkdir(state,{mode:0o700});await mkdir(bin);
 const id='1'.repeat(32),receipt={installationId:id,bundleVersion:'c1.0',resources:deriveResources(id),phase:'recovery_required'};
 await writeFile(join(state,'receipt.json'),JSON.stringify(receipt),{mode:0o600});await writeFile(join(state,'identity.json'),JSON.stringify({installationId:id,bundleVersion:'c1.0',config:{mode:'loopback'}}),{mode:0o600});
 await writeFile(join(bin,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$C1_CALLS"\nprintf \'[{"Labels":{"org.casimir.installation":"'+id+'"},"Config":{"Labels":{"org.casimir.installation":"'+id+'"}},"State":{"Running":false}}]\\n\'\n',{mode:0o755});
 const old=process.env.PATH;process.env.PATH=bin+':'+old;process.env.C1_CALLS=log;t.after(()=>{process.env.PATH=old;delete process.env.C1_CALLS;});
 await assert.rejects(()=>operate(state,'stop'),/maintenance_or_recovery_refused/);
 assert.ok((await readFile(log,'utf8')).trim().split('\n').every(line=>line.startsWith('container inspect ')||line.startsWith('volume inspect ')));
 assert.deepEqual(JSON.parse(await readFile(join(state,'receipt.json'),'utf8')),receipt);
});
test('only_completed_restore_allows_absent_services_and_every_volume_must_be_owned',async t=>{
 const root=await mkdtemp('/tmp/c1-restored-operate-'),state=join(root,'state'),bin=join(root,'bin');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(state,{mode:0o700});await mkdir(bin);
 const id='2'.repeat(32),receipt={installationId:id,bundleVersion:'c1.0',resources:deriveResources(id),phase:'stopped'};
 await writeFile(join(state,'receipt.json'),JSON.stringify(receipt),{mode:0o600});await writeFile(join(state,'identity.json'),JSON.stringify({installationId:id,bundleVersion:'c1.0',config:{mode:'loopback'}}),{mode:0o600});
 await writeFile(join(bin,'docker'),'#!/bin/sh\nif [ "$1" = volume ]; then printf \'[{"Labels":{"org.casimir.installation":"'+id+'"}}]\\n\';else echo "Error: No such object: fixture" >&2;exit 1;fi\n',{mode:0o755});
 const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>{process.env.PATH=old;});
 await assert.rejects(()=>operate(state,'status'),/docker_operation_failed/);
 await writeFile(join(state,'restoration.json'),JSON.stringify({phase:'complete',installationId:id}),{mode:0o600});assert.equal((await operate(state,'status')).outcome,'stopped');
 await writeFile(join(bin,'docker'),'#!/bin/sh\nprintf \'[{"Labels":{"org.casimir.installation":"foreign"}}]\\n\'\n',{mode:0o755});await assert.rejects(()=>operate(state,'start'),/foreign_resource_refused/);
});
test('incomplete_upgrade_refuses_ordinary_commands_before_docker',async t=>{
 const root=await mkdtemp('/tmp/c1-upgrade-admission-');t.after(()=>rm(root,{recursive:true,force:true}));
 const id='3'.repeat(32),receipt={installationId:id,bundleVersion:'c1.1',resources:deriveResources(id),phase:'maintenance'};
 for(const [name,value]of Object.entries({'identity.json':{installationId:id,bundleVersion:'c1.1'},'receipt.json':receipt,'upgrade.json':{id:'u',targetHash:'h'}}))await writeFile(join(root,name),JSON.stringify(value),{mode:0o600});
 for(const command of ['start','stop','status'])await assert.rejects(()=>operate(root,command),/upgrade_incomplete_resume_upgrade/);
 await writeFile(join(root,'upgrade-complete.json'),JSON.stringify({id:'other',targetHash:'h'}),{mode:0o600});await assert.rejects(()=>operate(root,'start'),/upgrade_incomplete_resume_upgrade/);
 assert.deepEqual(JSON.parse(await readFile(join(root,'receipt.json'),'utf8')),receipt);
});
