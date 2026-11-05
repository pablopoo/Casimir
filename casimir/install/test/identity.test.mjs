import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api=await import('../../../platform/packages/api/src/casimir/lifecycle/identity.ts').catch(()=>({}));
const resources=await import('../../../platform/packages/api/src/casimir/lifecycle/resources.ts').catch(()=>({}));
const config={format:1,mode:'loopback',controlOrigin:'http://127.0.0.1:4485',appOrigin:'http://127.0.0.1:4486',bindAddress:'127.0.0.1',controlPort:4485,appPort:4486};
const bundle={version:'c1.0',hash:'a'.repeat(64)};
async function fixture(t){const p=await mkdtemp(join(tmpdir(),'casimir identity '));t.after(()=>rm(p,{recursive:true,force:true}));return join(p,'state');}
test('interrupted_initialize_retains_identity_and_secret',async t=>{
 assert.equal(typeof api.initializeInstallation,'function','initializer contract missing');
 const state=await fixture(t);
 await assert.rejects(()=>api.initializeInstallation(state,config,bundle,async()=>{throw Error('database unavailable');}),/database unavailable/);
 const before=await readFile(join(state,'identity.json'));
 const receipt=await api.initializeInstallation(state,config,bundle,async()=>({operatorId:'user_abcdefgh1234',projectId:'proj_abcdefgh1234'}));
 assert.deepEqual(await readFile(join(state,'identity.json')),before); assert.equal(receipt.phase,'ready');
 assert.equal((await stat(state)).mode & 0o777,0o700); assert.equal((await stat(join(state,'identity.json'))).mode & 0o777,0o600);
});
test('concurrent_install_has_one_owner_and_initialized_database_is_not_seeded',async t=>{
 const state=await fixture(t);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let calls=0;
 const first=api.initializeInstallation(state,config,bundle,async(id)=>{calls++;entered();await gate;return {operatorId:'user_abcdefgh1234',projectId:'proj_abcdefgh1234'};}); await ready;
 await assert.rejects(()=>api.initializeInstallation(state,config,bundle,async()=>{calls++;}),/busy/); release(); await first;
 await api.initializeInstallation(state,config,bundle,async()=>{calls++;});assert.equal(calls,1);
});
test('unknown_partial_state_and_config_changes_never_overwrite',async t=>{
 const state=await fixture(t);await mkdir(state,{mode:0o700});await writeFile(join(state,'identity.json'),'partial',{mode:0o600});
 await assert.rejects(()=>api.initializeInstallation(state,config,bundle,async()=>{}));assert.equal(await readFile(join(state,'identity.json'),'utf8'),'partial');
});
test('resources_are_exact_disjoint_and_foreign_labels_refused',()=>{
 assert.equal(typeof resources.deriveResources,'function');
 const a=resources.deriveResources('a'.repeat(32)),b=resources.deriveResources('b'.repeat(32));assert.notEqual(a.volumes.database,b.volumes.database);
 assert.throws(()=>resources.deriveResources('../evil'));
 assert.throws(()=>resources.assertOwnedResource({Labels:{'org.casimir.installation':'b'.repeat(32)}},'a'.repeat(32)),/foreign/);
 resources.assertOwnedResource({Labels:{'org.casimir.installation':'a'.repeat(32)}},'a'.repeat(32));
});
test('database_domain_apis_supply_ids_instead_of_local_seed_ids',async t=>{
 const state=await fixture(t);
 const receipt=await api.initializeInstallation(state,config,bundle,async()=>({operatorId:'user_abcdefgh1234',projectId:'proj_abcdefgh1234'}));
 assert.equal(receipt.operatorId,'user_abcdefgh1234');
 assert.equal(receipt.projectId,'proj_abcdefgh1234');
});
test('operation_inventories_accept_more_than_small_identity_limit_and_refuse_cap_without_replacing_state',async t=>{
 const state=await fixture(t),path=join(state,'restoration.json');
 await mkdir(state,{mode:0o700});
 assert.equal(typeof api.OPERATION_INVENTORY_MAX_BYTES,'number');
 const limit=api.OPERATION_INVENTORY_MAX_BYTES;
 const large={format:1,phase:'complete',installationId:'a'.repeat(32),sourceRecord:'b'.repeat(32),bundleHash:'c'.repeat(64),mapping:Array.from({length:300},(_,i)=>({operationId:`cmv_${i.toString(36).padStart(12,'0')}`,sourceImageId:'sha256:'+'d'.repeat(64),imageId:'sha256:'+'e'.repeat(64),sourceContainerId:'f'.repeat(64),containerId:'1'.repeat(64)}))};
 assert.ok(Buffer.byteLength(JSON.stringify(large)+'\n')>65536);
 await api.atomicPrivateJson(path,large,limit);
 assert.deepEqual(await api.readPrivate(path,limit),large);
 await assert.rejects(()=>api.readPrivate(path),/private_state_size_limit/);
 const exact={value:'x'.repeat(limit-Buffer.byteLength('{"value":""}\n'))};
 await api.atomicPrivateJson(path,exact,limit);
 const before=await readFile(path);
 const over={value:'x'.repeat(limit-Buffer.byteLength('{"value":""}\n')+1)};
 await assert.rejects(()=>api.atomicPrivateJson(path,over,limit),/private_state_size_limit/);
 assert.deepEqual(await readFile(path),before);
 assert.deepEqual(await readdir(state),['restoration.json']);
});
test('atomic_private_file_writes_exact_utf8_bytes_and_rejects_oversize_without_replacement',async t=>{
 const state=await fixture(t),path=join(state,'api.env');
 await mkdir(state,{mode:0o700});
 assert.equal(typeof api.atomicPrivateFile,'function','raw private file writer contract missing');
 await api.atomicPrivateFile(path,'CASIMIR_MANAGEMENT_ENABLED=true\n',64);
 assert.equal(await readFile(path,'utf8'),'CASIMIR_MANAGEMENT_ENABLED=true\n');
 assert.equal((await stat(path)).mode&0o777,0o600);
 const before=await readFile(path);
 await assert.rejects(()=>api.atomicPrivateFile(path,'é'.repeat(33),64),/private_state_size_limit/);
 assert.deepEqual(await readFile(path),before);
 assert.deepEqual(await readdir(state),['api.env']);
});

test('atomic_private_file sets its API reader owner before publishing the replacement',async t=>{
 const state=await fixture(t),path=join(state,'management.json');
 await mkdir(state,{mode:0o700});
 await writeFile(path,'old\n',{mode:0o600});
 const uid=process.getuid(),gid=process.getgid();
 await api.atomicPrivateFile(path,'new\n',64,{uid,gid});
 assert.equal(await readFile(path,'utf8'),'new\n');
 const metadata=await stat(path);
 assert.equal(metadata.uid,uid);
 assert.equal(metadata.gid,gid);
 assert.equal(metadata.mode&0o777,0o600);
 if(uid!==0){
  await assert.rejects(
   api.atomicPrivateFile(path,'must-not-publish\n',64,{uid:65534,gid:65534}),
   (error)=>error?.code==='EPERM',
  );
  assert.equal(await readFile(path,'utf8'),'new\n');
 }
 assert.deepEqual(await readdir(state),['management.json']);
});
