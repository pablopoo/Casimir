import {retainedReleases} from '../../platform/packages/api/src/casimir/lifecycle/retention.ts';
import {deriveResources,deriveIdentityEgressNetwork} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
const AUTH_SETUP_CHECKPOINT_MAX_BYTES=1024*1024;
export function restoreNetworkNames(installationId){const resources=deriveResources(installationId);return [resources.runtimeNetwork,resources.appsNetwork,resources.frontNetwork,deriveIdentityEgressNetwork(installationId)];}
export function validateRestoreReferences(inventory,descriptor){
 if(descriptor?.format!==1||descriptor.installationId!==inventory.metadata.installationId||descriptor.restoreResume?.sourceKind!=='backup'||descriptor.restoreResume?.sourcePhase!=='maintenance'||descriptor.restoreResume?.recordId!==descriptor.recordId||!/^[a-f0-9]{32}$/.test(descriptor.recordId)||!Array.isArray(descriptor.artifacts)||!Array.isArray(descriptor.operations)||!Array.isArray(descriptor.compatibility))throw new Error('restore_inventory_identity');
 const files=new Map(inventory.files.map(f=>[f.path,f]));
 for(const path of ['control.dump','app.sqlite','descriptor.json','state/identity.json','state/receipt.json','state/profile.json','state/runner.json','state/runtime-env.json','state/db.env','state/database.env','state/api.env','state/control.conf','state/closed.conf','routes/route.conf'])if(!files.has(path))throw new Error('restore_reference_missing');
 const ownerPath='state/management-owner.json',configPath='state/management.json',checkpointPath='state/auth-setup-checkpoint.json',ownerPresent=files.has(ownerPath),configPresent=files.has(configPath),checkpointPresent=files.has(checkpointPath),metadataReferences=new Set(inventory.metadata.references??[]);
 if(ownerPresent!==configPresent||ownerPresent!==metadataReferences.has(ownerPath)||configPresent!==metadataReferences.has(configPath)||checkpointPresent!==metadataReferences.has(checkpointPath))throw new Error('restore_management_config_pair');
 if(checkpointPresent&&(!Number.isSafeInteger(files.get(checkpointPath).bytes)||files.get(checkpointPath).bytes<1||files.get(checkpointPath).bytes>AUTH_SETUP_CHECKPOINT_MAX_BYTES))throw new Error('restore_auth_setup_checkpoint_size');
 if(!/^[a-f0-9]{32}\.sqlite$/.test(descriptor.snapshot?.path)||files.get('app.sqlite').sha256!==descriptor.snapshot.sha256)throw new Error('restore_snapshot_reference');
 const ids=new Set();for(const a of descriptor.artifacts){const f=files.get('artifacts/'+a.path);if(ids.has(a.id)||!/^car_[a-z0-9]{12}$/.test(a.id)||!/^sealed\/upl_[a-z0-9]{12}\.gz$/.test(a.path)||!f||f.sha256!==a.sha256||f.bytes!==Number(a.bytes))throw new Error('restore_artifact_reference');ids.add(a.id);}
 const operations=new Set();for(const op of descriptor.operations){if(operations.has(op.id)||!/^cmv_[a-z0-9]{12}$/.test(op.id)||!['succeeded','failed'].includes(op.phase)||!ids.has(op.artifact_id))throw new Error('restore_operation_reference');operations.add(op.id);if(op.secret_revision)for(const file of ['env.json','release.json'])if(!files.has('runtime/'+op.id+'/'+file))throw new Error('restore_secret_reference');}
 const current=descriptor.operations.find(op=>op.id===descriptor.currentOperation);if(current?.phase!=='succeeded'||!current.image_id||!current.candidate_id)throw new Error('restore_current_reference');
 const required=retainedReleases(current,descriptor.operations).map(op=>op.id);
 if(descriptor.compatibility.length!==required.length||required.some(id=>!descriptor.compatibility.some(c=>c.operationId===id&&c.schemaDigest===descriptor.snapshot.schemaDigest)))throw new Error('restore_compatibility_reference');
 return true;
}
