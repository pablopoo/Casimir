import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {withStateLock,atomicPrivateJson,readPrivate,OPERATION_INVENTORY_MAX_BYTES} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import {deriveResources,assertOwnedResource} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import {docker} from './install.mjs';
export async function operate(state,command){
 if(!['status','stop','start'].includes(command))throw new Error('unsupported_lifecycle_command');
 // No initialization or credential regeneration on a lifecycle command.
 await readPrivate(join(state,'receipt.json'));
 return withStateLock(state,async()=>{
  const receipt=await readPrivate(join(state,'receipt.json')),identity=await readPrivate(join(state,'identity.json'));
  if(receipt.installationId!==identity.installationId||receipt.bundleVersion!==identity.bundleVersion||JSON.stringify(receipt.resources)!==JSON.stringify(deriveResources(identity.installationId)))throw new Error('receipt_identity_mismatch');
  try{const removal=await readPrivate(join(state,'uninstall.json'));if(removal.installationId!==identity.installationId||removal.phase!=='complete')throw new Error('uninstall_incomplete_resume_uninstall');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{const intent=await readPrivate(join(state,'upgrade.json'));const complete=await readPrivate(join(state,'upgrade-complete.json'));if(complete.id!==intent.id||complete.targetHash!==intent.targetHash)throw new Error('upgrade_incomplete_resume_upgrade');}catch(error){if(error.code!=='ENOENT')throw error;try{await readPrivate(join(state,'upgrade.json'));throw new Error('upgrade_incomplete_resume_upgrade');}catch(missing){if(missing.code!=='ENOENT')throw missing;}}
  const compose=join(state,'compose.json');
  let restored=false;
  if(receipt.phase==='stopped'){
   try{const restoration=await readPrivate(join(state,'restoration.json'),OPERATION_INVENTORY_MAX_BYTES);restored=restoration.phase==='complete'&&restoration.installationId===receipt.installationId;}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!restored)try{const removed=await readPrivate(join(state,'uninstall.json'));restored=removed.phase==='complete'&&removed.installationId===receipt.installationId;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const name of Object.values(receipt.resources.volumes))assertOwnedResource(JSON.parse(docker(['volume','inspect',name]))[0],receipt.installationId);
  for(const name of ['db','api','executor','control-ingress','app-ingress',...(identity.config.mode==='tls'?['tls-ingress']:[])]){
   let container;try{container=JSON.parse(docker(['container','inspect',receipt.resources.scope+'-'+name]))[0];}catch(error){if(restored&&error.code==='not_found')continue;throw error;}assertOwnedResource(container,receipt.installationId);
   if(receipt.phase==='stopped'&&container.State.Running&&command==='status')throw new Error('stopped_installation_has_running_service');
  }
  const job=(action,options={})=>JSON.parse(docker(['compose','-f',compose,'run','--rm','--no-deps','-T','operator','node','casimir/dist/lifecycle.mjs',action],options));
  if(command==='start'){
   if(!['stopped','ready','maintenance'].includes(receipt.phase))throw new Error('maintenance_or_recovery_refused');
   if(receipt.phase==='maintenance'){const maintenance=await readPrivate(join(state,'maintenance.json'));if(maintenance.kind!=='backup'||maintenance.phase!=='verified')throw new Error('verified_backup_required');}
   if(receipt.phase==='stopped'||receipt.phase==='maintenance'){
    docker(['compose','-f',compose,'up','-d','--wait','db','api','control-ingress','app-ingress',...(identity.config.mode==='tls'?['tls-ingress']:[])]);
    const resumed=job('finish-start');if(resumed.outcome!=='ready')return resumed;
    await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'ready'});
   }
   docker(['compose','-f',compose,'up','-d','--wait','executor']);
   const deadline=Date.now()+30000;let result;
   do{result=job('status');if(result.outcome==='ready')return result;await delay(500);}while(Date.now()<deadline);
   return result;
  }
  if(receipt.phase==='stopped'){if(command==='stop')docker(['compose','-f',compose,'stop']);return {outcome:'stopped',code:'operator_stopped',installationId:receipt.installationId,bundleVersion:receipt.bundleVersion};}
  if(command==='status')return job('status');
  if(!['ready','maintenance'].includes(receipt.phase))throw new Error('maintenance_or_recovery_refused');
  const current=job('status');if(current.outcome==='stopped'){await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'stopped'});docker(['compose','-f',compose,'stop']);return current;}
  const record=job('request-stop');await atomicPrivateJson(join(state,'maintenance.json'),record);
  await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'maintenance'});
  const deadline=Date.now()+120000;let drained=false;
  while(Date.now()<deadline){if(job('drain-status',{timeout:Math.max(1,Math.min(10000,deadline-Date.now()))}).drained){drained=true;break;}await delay(500);}
  if(!drained)return {outcome:'blocked',code:'stop_drain_timeout',installationId:receipt.installationId,bundleVersion:receipt.bundleVersion,operationId:record.id};
  docker(['compose','-f',compose,'stop','executor']);
  const result=job('finish-stop');
  if(result.outcome!=='stopped'||result.installationId!==receipt.installationId)throw new Error('stop_identity');
  await atomicPrivateJson(join(state,'receipt.json'),{...receipt,phase:'stopped'});
  await atomicPrivateJson(join(state,'maintenance.json'),{...record,phase:'complete'});
  await atomicPrivateJson(join(state,'retention.json'),job('retention-inventory'),OPERATION_INVENTORY_MAX_BYTES);
  docker(['compose','-f',compose,'stop']);return result;
 });
}
