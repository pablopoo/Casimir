import {readFile,mkdir,readdir,copyFile,chmod,chown,lstat,stat,open,rm} from 'node:fs/promises';import {join,dirname,resolve} from 'node:path';import {spawn} from 'node:child_process';import {createReadStream} from 'node:fs';import {pipeline} from 'node:stream/promises';
import {readEncryptedBackup} from '../../platform/packages/api/src/casimir/lifecycle/backup-format.ts';import {privateState,withStateLock,atomicPrivateFile,atomicPrivateJson,OPERATION_INVENTORY_MAX_BYTES} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';import {deriveResources} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import {verifyBundle,hashFile} from './bundle.mjs';import {verifyImageArchive} from './image-archive.mjs';import {preflight,preflightRestoreDisk} from './preflight.mjs';import {docker,renderCompose} from './install.mjs';import {validateCertificates} from './tls.mjs';
import {validateRestoreReferences,restoreNetworkNames} from './restore-inventory.mjs';
import {recordSourceRelease} from './source-release.mjs';
import {inspectRestoredManagementState,rewriteAuthSetupStatePath} from './management-state.mjs';
export async function restore(state,input,key,bundle){
 for(const path of [state,input,key,bundle])if(resolve(path)!==path||/[\0\r\n,]/.test(path))throw new Error('restore_absolute_paths_required');
 await privateState(state);if((await readdir(state)).length)throw new Error('restore_nonempty_target_refused');
 return withStateLock(state,async()=>{
  const manifest=await verifyBundle(bundle),bundleHash=await hashFile(join(bundle,'bundle.json'));
  const bundleBytes=manifest.files.reduce((n,f)=>n+f.bytes,0),inputInfo=await lstat(input);
  if(!inputInfo.isFile())throw new Error('restore_backup_size');
  const disk=await preflightRestoreDisk({statePath:state,bundleBytes,backupInputBytes:inputInfo.size});if(!disk.ok)throw new Error('insufficient_restore_disk');
  // Authentication and all references precede any Docker resources or database writes.
  const staging=join(state,'authenticated');const inventory=await readEncryptedBackup(input,key,staging,{expectedInputBytes:inputInfo.size}),files=join(staging,'files');
  const identity=JSON.parse(await readFile(join(files,'state/identity.json'),'utf8')),receipt=JSON.parse(await readFile(join(files,'state/receipt.json'),'utf8')),descriptor=JSON.parse(await readFile(join(files,'descriptor.json'),'utf8'));
  validateRestoreReferences(inventory,descriptor);
  if(inventory.metadata.installationId!==identity.installationId||receipt.installationId!==identity.installationId||descriptor.installationId!==identity.installationId||inventory.metadata.bundleVersion!==manifest.version||identity.bundleVersion!==manifest.version||identity.bundleHash!==bundleHash||JSON.stringify(descriptor.runtime)!==JSON.stringify(manifest.runtime))throw new Error('restore_bundle_identity');
  const managementState=await inspectRestoredManagementState(join(files,'state'),identity,receipt);
  const rewrittenApiEnv=managementState.managementEnabled
    ? rewriteAuthSetupStatePath(await readFile(join(files,'state/api.env'),'utf8'),state)
    : null;
  const config=identity.config;
  if(config.mode==='external-tls')await validateCertificates({...config,certificatePaths:{ca:join(files,'state/tls-ca.pem')}});
  if(config.mode==='tls')await validateCertificates({...config,certificatePaths:{certificate:join(files,'state/tls-cert.pem'),key:join(files,'state/tls-key.pem'),ca:join(files,'state/tls-ca.pem')}});
  const qualification=await preflight({stateParent:dirname(state),statePath:state,config,bundleBytes});if(!qualification.ok)throw new Error(qualification.codes.join(','));
  const r=deriveResources(identity.installationId);
  for(const [kind,names]of [['volume',Object.values(r.volumes)],['network',restoreNetworkNames(identity.installationId)],['container',['db','api','executor','init','migrate','control-ingress','app-ingress','tls-ingress'].map(s=>r.scope+'-'+s)]])for(const name of names){try{docker([kind,'inspect',name]);throw new Error('restore_destination_resource_exists');}catch(error){if(error.code!=='not_found')throw error;}}
  const verifiedArchives=new Set();for(const image of manifest.images){const archiveKey=image.archive+':'+image.imageId;if(!verifiedArchives.has(archiveKey)){await verifyImageArchive(join(bundle,image.archive),image.imageId);verifiedArchives.add(archiveKey);}try{docker(['image','inspect',image.imageId]);}catch(error){if(error.code!=='not_found')throw error;docker(['load','--input',join(bundle,image.archive)]);}}
  for(const entry of await readdir(join(files,'state'),{withFileTypes:true})){if(!entry.isFile())throw new Error('restore_state_regular');await copyFile(join(files,'state',entry.name),join(state,entry.name));await chmod(join(state,entry.name),0o600);}
  if(rewrittenApiEnv!==null)await atomicPrivateFile(join(state,'api.env'),rewrittenApiEnv,64*1024);
  await recordSourceRelease(state,await readFile(join(bundle,'bundle.json'),'utf8'),bundleHash);
  const images=Object.fromEntries(manifest.images.map(i=>[i.role,i.imageId]));const compose=renderCompose({installationId:identity.installationId,state,images,uid:0,gid:0,socketGid:(await stat('/var/run/docker.sock')).gid,config,managementConfig:managementState.managementConfig,identityEgress:managementState.managementEnabled});
  compose.services.migrate.environment.CASIMIR_BUNDLE_VERSION=manifest.version;
  compose.services.operator.volumes=compose.services.operator.volumes.map(v=>v==='artifacts:/artifacts:ro'?'artifacts:/artifacts':v==='routes:/routes:ro'?'routes:/routes':v);
  compose.services.operator.volumes.push({type:'bind',source:join(state,'restore-descriptor.json'),target:'/restore/descriptor.json',read_only:true});
  await atomicPrivateJson(join(state,'compose.json'),compose);await atomicPrivateJson(join(state,'restore-descriptor.json'),descriptor);await chown(join(state,'restore-descriptor.json'),1000,1000);
  for(const name of ['profile.json','runner.json','runtime-env.json',...(managementState.managementConfig?['management.json']:[]),...(config.mode!=='loopback'?['tls-ca.pem']:[])])await chown(join(state,name),1000,1000);
  for(const name of ['control.conf','closed.conf',...(config.mode==='tls'?['tls.conf','tls-cert.pem','tls-key.pem']:[])])await chown(join(state,name),101,101);
  await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'maintenance'});await atomicPrivateJson(join(state,'restoration.json'),{format:1,phase:'authenticated',installationId:identity.installationId,sourceRecord:descriptor.recordId,bundleHash});
  docker(['compose','-f',join(state,'compose.json'),'up','-d','--wait','db']);
  docker(['compose','-f',join(state,'compose.json'),'run','--rm','--no-deps','-T','init']);
  const pg=spawn('docker',['exec','-i',r.dbContainer,'pg_restore','--username=casimir','--dbname=casimir','--exit-on-error','--no-owner','--no-acl'],{stdio:['pipe','ignore','pipe']});pg.stderr.resume();const exited=new Promise((res,rej)=>{pg.once('error',rej);pg.once('close',res);});await pipeline(createReadStream(join(files,'control.dump')),pg.stdin);if(await exited!==0)throw new Error('restore_database_failed');
  // Only the authenticated files directory is delegated to the nonroot import
  // helper. Its parent remains private; no readable plaintext is placed in docs.
  async function readable(path){const s=await lstat(path);if(s.isDirectory()){await chmod(path,0o755);for(const name of await readdir(path))await readable(join(path,name));}else if(s.isFile())await chmod(path,0o644);else throw new Error('restore_regular_files');}await readable(files);
  const args=['run','--rm','--label','org.casimir.installation='+identity.installationId,'--label','org.casimir.role=restore-import','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','128','--mount',`type=bind,src=${files},dst=/source,readonly`];
  for(const [target,source]of [['artifacts',r.volumes.artifacts],['runtime',r.volumes.runtimeSecrets],['snapshots',r.volumes.snapshots],['routes',r.volumes.routes]])args.push('--mount',`type=volume,src=${source},dst=/${target}`);
  args.push(images.lifecycle,'node','casimir/install/restore-import.mjs');const imported=JSON.parse(docker(args));if(imported.installationId!==identity.installationId)throw new Error('restore_import_identity');
  docker(['compose','-f',join(state,'compose.json'),'up','-d','--no-deps','app-ingress']);
  const mapped=JSON.parse(docker(['compose','-f',join(state,'compose.json'),'run','--rm','--no-deps','-T','operator','node','casimir/dist/lifecycle.mjs','restore-runtime']));if(mapped.outcome!=='stopped')throw new Error('restore_runtime_mapping');
  await atomicPrivateJson(join(state,'restoration.json'),{format:1,phase:'complete',installationId:identity.installationId,sourceRecord:descriptor.recordId,bundleHash,mapping:mapped.mapping},OPERATION_INVENTORY_MAX_BYTES);await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'stopped'});
  docker(['compose','-f',join(state,'compose.json'),'stop']);await rm(staging,{recursive:true});return mapped;
 });
}
