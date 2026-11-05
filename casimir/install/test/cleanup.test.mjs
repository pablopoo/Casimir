import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';
import {planCleanup,uninstall,networkReferences} from '../cleanup.mjs';import {operate} from '../operate.mjs';import {deriveResources} from '../../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import {tmpdir} from 'node:os';
const executableScratch=process.env.CASIMIR_TEST_EXEC_TMPDIR??tmpdir();
test('uninstall_preserves_all_data_and_resumes_only_its_owned_removal',async t=>{
 const root=await mkdtemp(join(executableScratch,'c1-cleanup-')),state=join(root,'state'),bin=join(root,'bin'),log=join(root,'calls');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(state,{mode:0o700});await mkdir(bin);
 const id='3'.repeat(32),resources=deriveResources(id),receipt={installationId:id,bundleVersion:'c1.0',resources,phase:'stopped'};
 for(const [name,value]of Object.entries({'receipt.json':receipt,'identity.json':{installationId:id,bundleVersion:'c1.0',config:{mode:'loopback'}},'compose.json':{services:{}},'uninstall.json':{installationId:id,phase:'removing'}}))await writeFile(join(state,name),JSON.stringify(value),{mode:0o600});
 await writeFile(join(bin,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$C1_CALLS"\ncase "$1 $2" in\n"volume inspect") printf \'[{"Labels":{"org.casimir.installation":"'+id+'"},"UsageData":{"Size":123}}]\\n\';;\n"image ls"|"container ls") :;;\n*) echo "Error: No such object: fixture" >&2;exit 1;;\nesac\n',{mode:0o755});
 const old=process.env.PATH;process.env.PATH=bin+':'+old;process.env.C1_CALLS=log;t.after(()=>{process.env.PATH=old;delete process.env.C1_CALLS;});
 await assert.rejects(()=>operate(state,'start'),/uninstall_incomplete_resume_uninstall/);
 const before=await planCleanup(state);assert.equal(before.retained.filter(r=>r.kind==='volume').length,Object.keys(resources.volumes).length);
 const result=await uninstall(state);assert.equal(result.code,'platform_uninstalled_data_retained');assert.equal(result.automaticImageOrArtifactGc,false);
 assert.deepEqual(JSON.parse(await readFile(join(state,'receipt.json'),'utf8')),receipt);
 assert.ok(!(await readFile(log,'utf8')).includes('volume rm'));
 assert.equal(JSON.parse(await readFile(join(state,'uninstall.json'),'utf8')).phase,'complete');
 assert.equal((await uninstall(state)).code,'platform_uninstalled_data_retained');
});
test('stopped_and_foreign_container_references_pin_empty_endpoint_networks',()=>{
 const n={Id:'network-id',Name:'network-name',Containers:{}};
 assert.deepEqual(networkReferences(n,[{Id:'stopped',State:{Running:false},HostConfig:{NetworkMode:'network-name'}},{Id:'foreign',NetworkSettings:{Networks:{alias:{NetworkID:'network-id'}}}},{Id:'unrelated',HostConfig:{NetworkMode:'other'}}]),['stopped','foreign']);
});
test('cleanup_inventories_the_optional_identity_egress_network_as_an_owned_resource',async t=>{
 const root=await mkdtemp(join(executableScratch,'c1-cleanup-identity-egress-')),state=join(root,'state'),bin=join(root,'bin');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(state,{mode:0o700});await mkdir(bin);
 const id='7'.repeat(32),resources=deriveResources(id),egress=`casimir-${id}-identity-egress`;
 const receipt={installationId:id,bundleVersion:'c1.0',resources,phase:'stopped'};
 for(const [name,value]of Object.entries({'receipt.json':receipt,'identity.json':{installationId:id,bundleVersion:'c1.0',config:{mode:'loopback'}},'compose.json':{services:{}}}))await writeFile(join(state,name),JSON.stringify(value),{mode:0o600});
 const script=`#!/bin/sh
case "$1 $2" in
  "volume inspect") printf '[{"Labels":{"org.casimir.installation":"${id}"},"UsageData":{"Size":1}}]\\n' ;;
  "network inspect") if [ "$3" = "${egress}" ]; then printf '[{"Id":"identity-egress-id","Name":"${egress}","Containers":{},"Labels":{"org.casimir.installation":"${id}"}}]\\n'; else echo 'Error: No such object: fixture' >&2; exit 1; fi ;;
  "container ls"|"image ls") printf '\\n' ;;
  *) echo 'Error: No such object: fixture' >&2; exit 1 ;;
esac
`;
 await writeFile(join(bin,'docker'),script,{mode:0o755});const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>{process.env.PATH=old;});
 const plan=await planCleanup(state);
 assert.ok(plan.ownedDisposable.some(item=>item.kind==='network'&&item.name===egress),'an empty owned identity egress network is eligible for scoped cleanup');
});
test('preserve_all_inventory_never_infers_uncertain_resources_disposable',async t=>{
 const root=await mkdtemp(join(executableScratch,'c1-cleanup-preserve-')),state=join(root,'state'),bin=join(root,'bin'),log=join(root,'calls');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(state,{mode:0o700});await mkdir(bin);
 const id='4'.repeat(32),resources=deriveResources(id),image='sha256:'+'a'.repeat(64),container='c'.repeat(64),app='d'.repeat(64),job='e'.repeat(64),receipt={installationId:id,bundleVersion:'c1.0',resources,phase:'stopped'};
 for(const [name,value]of Object.entries({'receipt.json':receipt,'identity.json':{installationId:id,bundleVersion:'c1.0',config:{mode:'loopback'}},'compose.json':{services:{}},'uninstall.json':{installationId:id,phase:'removing'},'retention.json':{format:1,mode:'preserve_all',installationId:id,observedAt:new Date().toISOString(),references:[],backups:[]}}))await writeFile(join(state,name),JSON.stringify(value),{mode:0o600});
 const script=`#!/bin/sh
printf "%s\\n" "$*" >> "$C1_CALLS"
case "$1 $2" in
"volume inspect") printf '[{"Labels":{"org.casimir.installation":"${id}"},"UsageData":{"Size":123}}]\\n' ;;
"container inspect") if [ "$3" = "${resources.scope}-db" ]; then printf '[{"Id":"${container}","Name":"/${resources.scope}-db","State":{"Running":false},"Config":{"Labels":{"org.casimir.installation":"${id}","org.casimir.role":"database"}}}]\\n'; elif [ "$3" = "${app}" ] && [ "$4" = "${job}" ]; then printf '[{"Id":"${app}","Name":"/${resources.scope}-app-cmv_000000000001","State":{"Running":true},"Config":{"Labels":{"org.casimir.installation":"${id}","org.casimir.role":"app"}}},{"Id":"${job}","Name":"/${resources.scope}-job-000000000001","State":{"Running":false},"Config":{"Labels":{"org.casimir.installation":"${id}","org.casimir.role":"job"}}}]\\n'; else echo 'Error: No such object: fixture' >&2; exit 1; fi ;;
"network inspect") if [ "$3" = "${resources.runtimeNetwork}" ]; then printf '[{"Id":"network-id","Name":"${resources.runtimeNetwork}","Containers":{},"Labels":{"org.casimir.installation":"${id}"}}]\\n'; else echo 'Error: No such object: fixture' >&2; exit 1; fi ;;
"image ls") printf '${image}\\n' ;;
"image inspect") printf '[{"Id":"${image}","Size":123}]\\n' ;;
"container ls") printf '${app}\\n${job}\\n' ;;
*) echo 'Error: No such object: fixture' >&2; exit 1 ;;
esac
`;
 await writeFile(join(bin,'docker'),script,{mode:0o755});const old=process.env.PATH;process.env.PATH=bin+':'+old;process.env.C1_CALLS=log;t.after(()=>{process.env.PATH=old;delete process.env.C1_CALLS;});
 const plan=await planCleanup(state);assert.equal(plan.preserveAll,true);assert.deepEqual(plan.ownedDisposable,[]);assert.ok(plan.retained.some(r=>r.resource===container&&r.kind==='container'&&r.reason==='retention_inventory_preserve_all'));assert.ok(plan.retained.some(r=>r.resource===app&&r.kind==='container'&&r.reason==='retention_inventory_preserve_all'));assert.ok(plan.retained.some(r=>r.resource===job&&r.kind==='container'&&r.reason==='retention_inventory_preserve_all'));assert.ok(plan.retained.some(r=>r.kind==='network'&&r.reason==='retention_inventory_preserve_all'));assert.ok(plan.retained.some(r=>r.kind==='image'&&r.reason==='retention_inventory_preserve_all'));
 await assert.rejects(()=>uninstall(state),/cleanup_retention_inventory_preserve_all/);
 const calls=await readFile(log,'utf8');assert.ok(!/(container|network|image) rm/.test(calls));
});
