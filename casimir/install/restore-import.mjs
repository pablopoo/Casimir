// Fixed nonroot import job, no socket/network/application imports.
import {readFile,copyFile,mkdir,lstat,chmod} from 'node:fs/promises';import {join} from 'node:path';
const descriptor=JSON.parse(await readFile('/source/descriptor.json','utf8'));
async function copy(source,target){const s=await lstat(source);if(!s.isFile())throw new Error('restore_regular_file');await mkdir(join(target,'..'),{recursive:true,mode:0o700});await copyFile(source,target);await chmod(target,0o400);}
for(const artifact of descriptor.artifacts){if(!/^sealed\/upl_[a-z0-9]{12}\.gz$/.test(artifact.path))throw new Error('restore_artifact_path');await copy('/source/artifacts/'+artifact.path,'/artifacts/'+artifact.path);}
for(const op of descriptor.operations.filter(o=>o.secret_revision)){if(!/^cmv_[a-z0-9]{12}$/.test(op.id))throw new Error('restore_operation_path');for(const name of ['env.json','release.json'])await copy('/source/runtime/'+op.id+'/'+name,'/runtime/'+op.id+'/'+name);}
if(!/^[a-f0-9]{32}\.sqlite$/.test(descriptor.snapshot.path))throw new Error('restore_snapshot_path');
await copy('/source/app.sqlite','/snapshots/'+descriptor.snapshot.path);await chmod('/snapshots/'+descriptor.snapshot.path,0o600);
await copy('/source/routes/route.conf','/routes/route.conf');await chmod('/routes/route.conf',0o644);
console.log(JSON.stringify({imported:true,installationId:descriptor.installationId}));
