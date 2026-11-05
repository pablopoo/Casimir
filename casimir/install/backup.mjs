import {mkdir,writeFile,readFile,lstat,open,rm} from 'node:fs/promises';import {join,dirname,resolve} from 'node:path';import {createWriteStream} from 'node:fs';import {spawn} from 'node:child_process';import {pipeline} from 'node:stream/promises';import {Transform} from 'node:stream';import {createHash} from 'node:crypto';
import {publishBackup} from './publish-backup.mjs';
import {withStateLock,readPrivate,atomicPrivateJson} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import {deriveResources,assertOwnedResource} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';import {docker} from './install.mjs';
export async function backup(state,output,key,dependencies={}){
 if(resolve(output)!==output||resolve(key)!==key||/[\0\r\n,]/.test(output+key))throw new Error('backup_absolute_paths_required');
 const keyInfo=await lstat(key);if(!keyInfo.isFile()||keyInfo.isSymbolicLink()||keyInfo.size!==32||(keyInfo.mode&0o777)!==0o600)throw new Error('backup_key_requires_private_32_bytes');
 try{await lstat(output);throw new Error('backup_output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const runDocker=dependencies.docker??docker;
 return withStateLock(state,async()=>{
  const receipt=await readPrivate(join(state,'receipt.json')),identity=await readPrivate(join(state,'identity.json'));const r=deriveResources(identity.installationId);
  if(receipt.installationId!==identity.installationId||receipt.bundleVersion!==identity.bundleVersion||!['ready','maintenance'].includes(receipt.phase))throw new Error('backup_identity_or_phase');
  const compose=join(state,'compose.json'),config=JSON.parse(await readFile(compose,'utf8'));
  for(const name of Object.values(r.volumes))assertOwnedResource(JSON.parse(runDocker(['volume','inspect',name]))[0],identity.installationId);
  for(const service of ['db','executor','api'])assertOwnedResource(JSON.parse(runDocker(['container','inspect',r.scope+'-'+service]))[0],identity.installationId);
  // Reuse the fixed read-only capture authority before requesting maintenance.
  const validation=JSON.parse(runDocker([
   'run','--rm',
   '--name',r.scope+'-management-state-preflight',
   '--label','org.casimir.task=c1',
   '--label','org.casimir.installation='+identity.installationId,
   '--label','org.casimir.role=management-state-preflight',
   '--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_READ_SEARCH',
   '--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','128',
   '--mount',`type=bind,src=${state},dst=/state,readonly`,
   config.services.operator.image,'node','casimir/install/management-state-preflight.mjs',state,
  ]));
  if(validation?.validated!==true){const code=typeof validation?.code==='string'&&/^[a-z0-9_]{1,96}$/.test(validation.code)?validation.code:'backup_management_state_invalid';throw new Error(code);}
  const job=action=>JSON.parse(runDocker(['compose','-f',compose,'run','--rm','--no-deps','-T','operator','node','casimir/dist/lifecycle.mjs',action]));
  const record=job('request-backup');await atomicPrivateJson(join(state,'maintenance.json'),record);await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'maintenance'});
  runDocker(['compose','-f',compose,'stop','executor','api']);
  for(const service of ['executor','api']){const stopped=JSON.parse(runDocker(['container','inspect',r.scope+'-'+service]))[0];assertOwnedResource(stopped,identity.installationId);if(stopped.State.Running)throw new Error('backup_service_still_running');}
  const descriptor=job('capture-backup');
  const stage=join(state,'backup-'+record.id);await mkdir(stage,{mode:0o700});
  await writeFile(join(stage,'descriptor.json'),JSON.stringify(descriptor),{mode:0o600});
  const dump=spawn('docker',['exec',r.dbContainer,'pg_dump','--username=casimir','--dbname=casimir','--format=custom','--no-owner','--no-acl'],{stdio:['ignore','pipe','pipe']});let bytes=0;let error='';dump.stderr.on('data',b=>{if(error.length<4096)error+=b;});const exited=new Promise((res,rej)=>{dump.on('error',rej);dump.on('close',res);});
  try{await pipeline(dump.stdout,new Transform({transform(chunk,_e,cb){bytes+=chunk.length;cb(bytes>8*1024**3?new Error('dump_size'):null,chunk);}}),createWriteStream(join(stage,'control.dump'),{flags:'wx',mode:0o600}));if(await exited!==0)throw new Error('database_dump_failed');}catch(e){dump.kill();throw e;}
  job('mark-backup-captured');
  const helper=r.scope+'-capture-'+record.id;
  const mounts=[['/state',state],['/artifacts',r.volumes.artifacts],['/snapshots',r.volumes.snapshots],['/routes',r.volumes.routes],['/runtime',r.volumes.runtimeSecrets]];
  const args=['run','--name',helper,'--label','org.casimir.installation='+identity.installationId,'--label','org.casimir.role=capture','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_READ_SEARCH','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','128'];
  for(const [target,source]of mounts)args.push('--mount',`type=${target==='/state'?'bind':'volume'},src=${source},dst=${target},readonly`);
  args.push('--mount',`type=bind,src=${key},dst=/key/backup.key,readonly`,'--mount',`type=bind,src=${stage},dst=/capture`,config.services.operator.image,'node','casimir/install/capture.mjs',state);
  const result=JSON.parse(runDocker(args));const captured=JSON.parse(runDocker(['container','inspect',helper]))[0];
  await atomicPrivateJson(join(state,'backup-helper-inspection.json'),{image:captured.Image,user:captured.Config.User,capAdd:captured.HostConfig.CapAdd,capDrop:captured.HostConfig.CapDrop,networkMode:captured.HostConfig.NetworkMode,readOnlyRootfs:captured.HostConfig.ReadonlyRootfs,mounts:captured.Mounts.map(({Type,Name,Source,Destination,RW})=>({Type,Name,Source,Destination,RW}))});
  if(result.verified!==true||result.recordId!==record.id)throw new Error('capture_verification');
  const data=await open(join(stage,'result.backup'),'r');const hash=createHash('sha256');for await(const chunk of data.createReadStream())hash.update(chunk);const sha256=hash.digest('hex');
  await publishBackup(join(stage,'result.backup'),output);
  await atomicPrivateJson(join(state,'backup-receipt.json'),{format:1,recordId:record.id,installationId:identity.installationId,bundleVersion:identity.bundleVersion,bundleHash:identity.bundleHash,output,sha256,phase:'verified',snapshot:descriptor.snapshot});
  job('mark-backup-verified:'+sha256);
  await atomicPrivateJson(join(state,'maintenance.json'),{...record,phase:'verified'});
  runDocker(['rm',helper]);await rm(stage,{recursive:true});
  return {outcome:'blocked',code:'backup_verified_maintenance_held',installationId:identity.installationId,bundleVersion:identity.bundleVersion,operationId:record.id,sha256};
 });
}
