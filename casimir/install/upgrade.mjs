import {readFile,chown,statfs} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash,randomBytes} from 'node:crypto';
import {withStateLock,readPrivate,atomicPrivateJson} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import {assertUpgradePair} from '../../platform/packages/api/src/casimir/lifecycle/upgrade.ts';
import {assertOwnedResource,deriveResources} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import {verifyBundle,hashFile} from './bundle.mjs';import {verifyImageArchive} from './image-archive.mjs';import {readSourceRelease} from './source-release.mjs';import {docker} from './install.mjs';
const compact=m=>({...m,files:[]});
export async function upgrade(state,bundle,backupPath){
 if(resolve(bundle)!==bundle||resolve(backupPath)!==backupPath)throw new Error('upgrade_absolute_paths_required');
 const target=await verifyBundle(bundle),targetText=await readFile(join(bundle,'bundle.json'),'utf8'),targetHash=createHash('sha256').update(targetText).digest('hex');
 return withStateLock(state,async()=>{
  let identity=await readPrivate(join(state,'identity.json')),receipt=await readPrivate(join(state,'receipt.json'));
  const r=deriveResources(identity.installationId);if(receipt.installationId!==identity.installationId||JSON.stringify(receipt.resources)!==JSON.stringify(r))throw new Error('upgrade_receipt_identity');
  const backup=await readPrivate(join(state,'backup-receipt.json'));
  if(backup.installationId!==identity.installationId||backup.phase!=='verified'||backup.output!==backupPath||await hashFile(backupPath)!==backup.sha256)throw new Error('upgrade_backup_required');
  let intent;try{intent=await readPrivate(join(state,'upgrade.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!intent){
   if(receipt.installationId!==identity.installationId||receipt.bundleHash!==identity.bundleHash||receipt.phase!=='maintenance'||backup.bundleHash!==identity.bundleHash)throw new Error('upgrade_verified_maintenance_required');
   const source=await readSourceRelease(state,identity.bundleHash);assertUpgradePair(source,target);
   intent={format:1,id:randomBytes(16).toString('hex'),installationId:identity.installationId,source:compact(source),target:compact(target),sourceHash:identity.bundleHash,targetHash,backupRecordId:backup.recordId,backupHash:backup.sha256};
   await atomicPrivateJson(join(state,'upgrade.json'),intent);
  }
  if(intent.installationId!==identity.installationId||intent.targetHash!==targetHash||intent.backupHash!==backup.sha256||intent.backupRecordId!==backup.recordId||![intent.sourceHash,intent.targetHash].includes(identity.bundleHash)||![intent.sourceHash,intent.targetHash].includes(receipt.bundleHash))throw new Error('upgrade_resume_conflict');
  assertUpgradePair(intent.source,target);
  for(const role of ['api','executor']){const c=JSON.parse(docker(['container','inspect',r.scope+'-'+role]))[0];assertOwnedResource(c,identity.installationId);const allowed=[intent.source,intent.target].map(m=>m.images.find(i=>i.role==='control').imageId);if(!allowed.includes(c.Image))throw new Error('upgrade_source_service_identity');}
  for(const name of Object.values(r.volumes))assertOwnedResource(JSON.parse(docker(['volume','inspect',name]))[0],identity.installationId);
  const disk=await statfs(state,{bigint:true});if(disk.bavail*disk.bsize<BigInt(Math.max(20*1024**3,3*target.files.reduce((n,f)=>n+f.bytes,0)+10*1024**3)))throw new Error('insufficient_upgrade_disk');
  const seen=new Set();for(const image of target.images){const key=image.archive+image.imageId;if(!seen.has(key)){await verifyImageArchive(join(bundle,image.archive),image.imageId);seen.add(key);}}
  for(const image of target.images){try{const info=JSON.parse(docker(['image','inspect',image.imageId]))[0];if(info.Id!==image.imageId)throw new Error('upgrade_image_identity');}catch(e){if(e.code!=='not_found')throw e;docker(['image','load','--input',join(bundle,image.archive)]);}}
  const composePath=join(state,'compose.json'),compose=JSON.parse(await readFile(composePath,'utf8')),control=target.images.find(i=>i.role==='control').imageId;
  const jobIntent=join(state,'upgrade-job.json');await atomicPrivateJson(jobIntent,intent);if(process.getuid()===0)await chown(jobIntent,1000,1000);
  const operator={...compose.services.operator,image:control,volumes:[...compose.services.operator.volumes.filter(v=>typeof v==='string'||v.target!=='/upgrade/intent.json'),{type:'bind',source:jobIntent,target:'/upgrade/intent.json',read_only:true}]};
  const staged={...compose,services:{...compose.services,operator}},stagedPath=join(state,'upgrade-compose.json');await atomicPrivateJson(stagedPath,staged);
  const job=action=>JSON.parse(docker(['compose','-f',stagedPath,'run','--rm','--no-deps','-T','operator','node','casimir/dist/lifecycle.mjs',action]));
  const status=job('upgrade-status');if(status.id&&status.id!==intent.id)throw new Error('upgrade_journal_identity');
  if(status.phase!=='complete'){
   docker(['compose','-f',composePath,'stop','executor','api']);
   const prepared=job('upgrade-prepare');if(prepared.code!=='upgrade_compatibility_verified')throw new Error('upgrade_prepare_failed');
   for(const role of ['init','migrate','api','executor','operator'])staged.services[role]={...staged.services[role],image:control};
   staged.services.migrate.environment={...staged.services.migrate.environment,CASIMIR_BUNDLE_VERSION:target.version};
   await atomicPrivateJson(composePath,staged);await atomicPrivateJson(stagedPath,staged);
   identity={...identity,bundleVersion:target.version,bundleHash:targetHash};receipt={...receipt,bundleVersion:target.version,bundleHash:targetHash,phase:'maintenance'};
   await atomicPrivateJson(join(state,'identity.json'),identity);await atomicPrivateJson(join(state,'receipt.json'),receipt);await atomicPrivateJson(join(state,'source-release.json'),{format:1,text:targetText});
   docker(['compose','-f',composePath,'up','-d','--wait','db','api','control-ingress','app-ingress',...(identity.config.mode==='tls'?['tls-ingress']:[])]);
   const exposed=job('upgrade-expose');if(exposed.outcome!=='ready')return exposed;
  }
  docker(['compose','-f',composePath,'up','-d','--wait','executor']);
  for(const role of ['api','executor']){const c=JSON.parse(docker(['container','inspect',r.scope+'-'+role]))[0];assertOwnedResource(c,identity.installationId);if(c.Image!==control||!c.State.Running)throw new Error('upgrade_target_service_identity');}
  const result=job('status');if(result.outcome!=='ready')return result;
  await atomicPrivateJson(join(state,'receipt.json'),{...receipt,bundleVersion:target.version,bundleHash:targetHash,phase:'ready'});
  await atomicPrivateJson(join(state,'maintenance.json'),{id:intent.id,installationId:identity.installationId,kind:'upgrade',phase:'complete',sourceVersion:intent.source.version,targetVersion:target.version});
  await atomicPrivateJson(join(state,'upgrade-complete.json'),{format:1,id:intent.id,targetHash});return result;
 });
}
