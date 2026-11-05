import {join} from 'node:path';import {readFile} from 'node:fs/promises';
import {readPrivate,withStateLock,atomicPrivateJson,OPERATION_INVENTORY_MAX_BYTES} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';import {deriveResources,deriveIdentityEgressNetwork,assertOwnedResource} from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';import {docker} from './install.mjs';import {operate} from './operate.mjs';
const roles=['db','init','migrate','management-state-preflight','api','executor','control-ingress','app-ingress','tls-ingress'];
export function networkReferences(network,containers){return containers.filter(c=>c.HostConfig?.NetworkMode===network.Name||c.HostConfig?.NetworkMode===network.Id||Object.entries(c.NetworkSettings?.Networks??{}).some(([name,settings])=>name===network.Name||settings.NetworkID===network.Id)).map(c=>c.Id);}
export async function planCleanup(state){
 const receipt=await readPrivate(join(state,'receipt.json')),identity=await readPrivate(join(state,'identity.json')),r=deriveResources(identity.installationId);
 if(receipt.installationId!==identity.installationId||JSON.stringify(receipt.resources)!==JSON.stringify(r))throw new Error('cleanup_identity');
 let inventory;try{inventory=await readPrivate(join(state,'retention.json'),OPERATION_INVENTORY_MAX_BYTES);if(inventory.installationId!==identity.installationId)throw new Error('cleanup_inventory_identity');}catch(e){if(e.code!=='ENOENT')throw e;}
 const preserveAll=inventory?.mode==='preserve_all';
 const ownedDisposable=[],retained=[];
 for(const role of roles){let c;try{c=JSON.parse(docker(['container','inspect',r.scope+'-'+role]))[0];}catch(e){if(e.code==='not_found')continue;throw e;}assertOwnedResource(c,identity.installationId);const expected=role==='db'?'database':role;if(c.Config.Labels['org.casimir.role']!==expected||c.Name!=='/'+r.scope+'-'+role)throw new Error('cleanup_container_identity');if(preserveAll)retained.push({resource:c.Id,kind:'container',reason:'retention_inventory_preserve_all',bytes:null});else if(c.State.Running)retained.push({resource:c.Id,kind:'container',reason:'running_service',bytes:null});else ownedDisposable.push({resource:c.Id,name:c.Name,kind:'container'});}
 for(const name of Object.values(r.volumes)){const v=JSON.parse(docker(['volume','inspect',name]))[0];assertOwnedResource(v,identity.installationId);retained.push({resource:name,kind:'volume',reason:'persistent_data_never_deleted',bytes:v.UsageData?.Size??null});}
 const containerIds=docker(['container','ls','--all','--quiet']).trim().split(/\s+/).filter(Boolean),containers=containerIds.length?JSON.parse(docker(['container','inspect',...containerIds])):[];
 if(preserveAll){const platform=new Set(retained.filter(r=>r.kind==='container').map(r=>r.resource));for(const c of containers){const labels=c.Config?.Labels??{};if(labels['org.casimir.installation']===identity.installationId&&!platform.has(c.Id)){retained.push({resource:c.Id,kind:'container',reason:'retention_inventory_preserve_all',bytes:null});platform.add(c.Id);}}}
 for(const name of [r.runtimeNetwork,r.appsNetwork,r.frontNetwork,deriveIdentityEgressNetwork(identity.installationId)]){let n;try{n=JSON.parse(docker(['network','inspect',name]))[0];}catch(e){if(e.code==='not_found')continue;throw e;}assertOwnedResource(n,identity.installationId);const attached=[...Object.keys(n.Containers??{}),...networkReferences(n,containers)];if(preserveAll)retained.push({resource:name,kind:'network',reason:'retention_inventory_preserve_all',bytes:null});else if(attached.length)retained.push({resource:name,kind:'network',reason:'referenced_by_running_or_stopped_container',bytes:null});else ownedDisposable.push({resource:n.Id,name,kind:'network'});}
 const compose=JSON.parse(await readFile(join(state,'compose.json'),'utf8')),allImages=docker(['image','ls','--no-trunc','--quiet']).trim().split(/\s+/).filter(Boolean);
 const ids=new Set([...Object.values(compose.services).map(s=>s.image),...allImages,...(inventory?.references??[]).map(ref=>ref.resource)]);
 for(const id of ids){let image;try{image=JSON.parse(docker(['image','inspect',id]))[0];}catch(e){if(e.code==='not_found'){retained.push({resource:id,kind:'image',reason:preserveAll?'retention_inventory_preserve_all':'referenced_image_missing',bytes:null});continue;}throw e;}const refs=inventory?.references.filter(ref=>ref.resource===id).flatMap(ref=>ref.reasons)??[];retained.push({resource:id,kind:'image',reason:preserveAll?'retention_inventory_preserve_all':refs.length?[...new Set(refs)].join(','):'shared_or_platform_image_preserved',bytes:image.Size});}
 retained.push({resource:state,kind:'private_state',reason:'identity_config_and_backup_references',bytes:null});
 return {installationId:identity.installationId,phase:receipt.phase,preserveAll,ownedDisposable,retained,automaticImageOrArtifactGc:false};
}
export async function uninstall(state){
 let marker;try{marker=await readPrivate(join(state,'uninstall.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!marker){const stopped=await operate(state,'stop');if(stopped.outcome!=='stopped')throw new Error('uninstall_requires_stopped');}
 return withStateLock(state,async()=>{
  const plan=await planCleanup(state);if(plan.preserveAll)throw new Error('cleanup_retention_inventory_preserve_all');if(plan.phase!=='stopped'||plan.retained.some(r=>r.reason==='running_service'))throw new Error('uninstall_requires_stopped');
  if(marker&&(marker.installationId!==plan.installationId||!['removing','complete'].includes(marker.phase)))throw new Error('uninstall_marker_identity');
  await atomicPrivateJson(join(state,'uninstall.json'),{format:1,installationId:plan.installationId,phase:'removing'});
  for(const item of plan.ownedDisposable.filter(r=>r.kind==='container')){
   const c=JSON.parse(docker(['container','inspect',item.resource]))[0];assertOwnedResource(c,plan.installationId);if(c.State.Running||c.Name!==item.name)throw new Error('cleanup_resource_changed');docker(['container','rm',item.resource]);
  }
  // Reinspect after removals; attached application/foreign containers pin networks.
  const after=await planCleanup(state);
  for(const item of after.ownedDisposable.filter(r=>r.kind==='network')){const n=JSON.parse(docker(['network','inspect',item.resource]))[0];assertOwnedResource(n,plan.installationId);if(Object.keys(n.Containers??{}).length)throw new Error('cleanup_network_changed');docker(['network','rm',item.resource]);}
  await atomicPrivateJson(join(state,'uninstall.json'),{format:1,installationId:plan.installationId,phase:'complete'});
  return {outcome:'stopped',code:'platform_uninstalled_data_retained',...await planCleanup(state)};
 });
}
