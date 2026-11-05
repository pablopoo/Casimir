import {test} from 'node:test';import assert from 'node:assert/strict';import * as restoreInventory from'../restore-inventory.mjs';
const {validateRestoreReferences}=restoreInventory;
function validFixture(){
 const id='1'.repeat(32),recordId='2'.repeat(32),schemaDigest='3'.repeat(64),snapshotHash='4'.repeat(64),artifactId='car_aaaaaaaaaaaa',artifactPath='sealed/upl_aaaaaaaaaaaa.gz',operationId='cmv_bbbbbbbbbbbb';
 const paths=['control.dump','app.sqlite','descriptor.json','state/identity.json','state/receipt.json','state/profile.json','state/runner.json','state/runtime-env.json','state/db.env','state/database.env','state/api.env','state/control.conf','state/closed.conf','routes/route.conf','artifacts/'+artifactPath];
 const inventory={metadata:{installationId:id,references:[...paths]},files:paths.map(path=>({path,bytes:1,sha256:path==='app.sqlite'?snapshotHash:path==='artifacts/'+artifactPath?'5'.repeat(64):'6'.repeat(64)}))};
 const current={id:operationId,deployment_id:'deployment-current',phase:'succeeded',image_id:'sha256:'+'7'.repeat(64),candidate_id:'8'.repeat(64),artifact_id:artifactId,previous_target:{route:null,previousOperationId:null,jobs:{}}};
 const descriptor={format:1,installationId:id,recordId,restoreResume:{sourceKind:'backup',sourcePhase:'maintenance',recordId},artifacts:[{id:artifactId,path:artifactPath,sha256:'5'.repeat(64),bytes:1}],operations:[current],currentOperation:operationId,compatibility:[{operationId,schemaDigest}],snapshot:{path:'9'.repeat(32)+'.sqlite',sha256:snapshotHash,schemaDigest}};
 return{inventory,descriptor};
}
test('restore_missing_referenced_payload_is_rejected_before_resources',()=>{
 const inventory={metadata:{installationId:'1'.repeat(32)},files:[]};const descriptor={format:1,installationId:'1'.repeat(32),recordId:'2'.repeat(32),restoreResume:{sourceKind:'backup',sourcePhase:'maintenance',recordId:'2'.repeat(32)},artifacts:[],operations:[],compatibility:[]};
 assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_reference_missing/);
 descriptor.restoreResume.sourceKind='stop';assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_inventory_identity/);
});
test('restore_requires_a_complete_and_referenced_management_key_pair',()=>{
 const{inventory,descriptor}=validFixture();assert.equal(validateRestoreReferences(inventory,descriptor),true);
 inventory.files.push({path:'state/management-owner.json',bytes:1,sha256:'a'.repeat(64)});inventory.metadata.references.push('state/management-owner.json');
 assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_management_config_pair/);
 inventory.files.push({path:'state/management.json',bytes:1,sha256:'b'.repeat(64)});inventory.metadata.references.push('state/management.json');
 assert.equal(validateRestoreReferences(inventory,descriptor),true);
 inventory.metadata.references=inventory.metadata.references.filter(path=>path!=='state/management.json');
 assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_management_config_pair/);
});
test('restore_requires_an_optional_pending_checkpoint_to_be_referenced_and_bounded',()=>{
 const{inventory,descriptor}=validFixture(),path='state/auth-setup-checkpoint.json';
 inventory.files.push({path,bytes:32,sha256:'a'.repeat(64)});
 assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_management_config_pair/);
 for(const ownerPath of ['state/management-owner.json','state/management.json']){
  inventory.files.push({path:ownerPath,bytes:1,sha256:'b'.repeat(64)});
  inventory.metadata.references.push(ownerPath);
 }
 inventory.metadata.references.push(path);
 assert.equal(validateRestoreReferences(inventory,descriptor),true);
 inventory.files.find((file)=>file.path===path).bytes=1_048_577;
 assert.throws(()=>validateRestoreReferences(inventory,descriptor),/restore_auth_setup_checkpoint_size/);
});
test('restore_collision_inventory_reserves_the_optional_identity_egress_network',()=>{
 assert.equal(typeof restoreInventory.restoreNetworkNames,'function','restore collision inventory helper missing');
 const id='8'.repeat(32),names=restoreInventory.restoreNetworkNames(id);
 assert.ok(names.includes(`casimir-${id}-identity-egress`));
 assert.deepEqual(names.slice(0,3),[`casimir-${id}-runtime`,`casimir-${id}-apps`,`casimir-${id}-front`]);
});
