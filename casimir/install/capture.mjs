// Trusted fixed capture recipe: no Docker socket, network or application imports.
import {readFile,writeFile,mkdir,copyFile,lstat,rm,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {writeEncryptedBackup,readEncryptedBackup} from '../../platform/packages/api/src/casimir/lifecycle/backup-format.ts';
import {inspectManagementStatePair} from './management-state.mjs';
const descriptor=JSON.parse(await readFile('/capture/descriptor.json','utf8'));
const identity=JSON.parse(await readFile('/state/identity.json','utf8'));
const receipt=JSON.parse(await readFile('/state/receipt.json','utf8'));
if(descriptor.installationId!==identity.installationId||receipt.installationId!==identity.installationId)throw new Error('capture_identity');
const operationalStatePath=process.argv[2];
const managementPair=await inspectManagementStatePair('/state',identity,receipt,operationalStatePath);
const root='/capture/plaintext';await mkdir(root,{mode:0o700});
async function copy(source,target,expected){
 const info=await lstat(source);if(!info.isFile()||info.size>16*1024**3)throw new Error('capture_regular_file_required');
 if(expected){const hash=createHash('sha256');for await(const chunk of createReadStream(source))hash.update(chunk);if(hash.digest('hex')!==expected)throw new Error('capture_hash');}
 await mkdir(join(root,target,'..'),{recursive:true,mode:0o700});await copyFile(source,join(root,target));
}
try{
 await copy('/capture/control.dump','control.dump');
 await copy('/snapshots/'+descriptor.snapshot.path,'app.sqlite',descriptor.snapshot.sha256);
 for(const artifact of descriptor.artifacts){if(!/^sealed\/upl_[a-z0-9]+\.gz$/.test(artifact.path))throw new Error('capture_artifact_path');await copy('/artifacts/'+artifact.path,'artifacts/'+artifact.path,artifact.sha256);}
 for(const name of ['identity.json','receipt.json','source-release.json','profile.json','runner.json','runtime-env.json','api.env','database.env','db.env','compose.json','control.conf','closed.conf','app-bootstrap.conf','maintenance.json']){
  try{await copy('/state/'+name,'state/'+name);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 if(managementPair){await copy(managementPair.ownerPath,'state/management-owner.json');await copy(managementPair.configPath,'state/management.json');}
 if(managementPair?.checkpointPath)await copy(managementPair.checkpointPath,'state/auth-setup-checkpoint.json');
 if(identity.config.mode==='external-tls')await copy('/state/tls-ca.pem','state/tls-ca.pem');
 if(identity.config.mode==='tls')for(const name of ['tls-ca.pem','tls-cert.pem','tls-key.pem','tls.conf'])await copy('/state/'+name,'state/'+name);
 // Retain runtime revisions only when explicitly referenced by saved operations.
 const revisions=descriptor.operations.filter(op=>op.secret_revision).map(op=>op.id);
 for(const revision of revisions){if(!/^cmv_[a-z0-9]+$/.test(revision))throw new Error('secret_revision');for(const name of ['env.json','release.json'])await copy('/runtime/'+revision+'/'+name,'runtime/'+revision+'/'+name);}
 await copy('/routes/route.conf','routes/route.conf');
 await writeFile(join(root,'descriptor.json'),JSON.stringify(descriptor),{mode:0o600});
 const references=['control.dump','app.sqlite','descriptor.json','state/identity.json','state/receipt.json','state/profile.json','state/runner.json','state/runtime-env.json','routes/route.conf',...(managementPair?['state/management-owner.json','state/management.json']:[]),...(managementPair?.checkpointPath?['state/auth-setup-checkpoint.json']:[]),...descriptor.artifacts.map(a=>'artifacts/'+a.path),...revisions.flatMap(r=>['runtime/'+r+'/env.json','runtime/'+r+'/release.json'])];
 await writeEncryptedBackup(root,'/capture/result.pending','/key/backup.key',{format:1,installationId:identity.installationId,bundleVersion:identity.bundleVersion,references});
 const checked=await readEncryptedBackup('/capture/result.pending','/key/backup.key','/capture/verification');
 if(checked.metadata.installationId!==identity.installationId)throw new Error('capture_verification_identity');
 await rename('/capture/result.pending','/capture/result.backup');
 console.log(JSON.stringify({verified:true,installationId:identity.installationId,recordId:descriptor.recordId,files:checked.files.length}));
}finally{await rm(root,{recursive:true,force:true});await rm('/capture/verification',{recursive:true,force:true});}
