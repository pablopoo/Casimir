import {runLifecycleJob} from './job-journal.ts';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';import {canonicalJson,parseCasimirManifest,assertCasimirRuntime} from '@void/deploy-core';
import {extractCasimirArtifact} from '../../../../../../packages/void/src/casimir/artifact-codec.ts';
import type {MvpContext} from '../mvp/runner.ts';import {mapMvpOperation} from '../mvp/store.ts';
import {assertOperationMappingSize} from './retention-inventory.ts';
// Called only on the isolated destination after authenticated inventory import.
// Original IDs stay in the immutable descriptor; explicit mappings record every
// image/container incarnation rebuilt on this daemon.
export async function restoreInstallationRuntime(ctx:MvpContext,descriptor:any){
 ctx.guard.assertLive();const id=ctx.profile.installationId;
 if(descriptor.format!==1||descriptor.installationId!==id||descriptor.restoreResume?.sourceKind!=='backup'||descriptor.restoreResume?.recordId!==descriptor.recordId||canonicalJson(descriptor.runtime)!==canonicalJson(ctx.profile.runtime))throw new Error('restore_descriptor_identity');
 const install=(await ctx.db.execute<{phase:string;project_id:string}>(sql`SELECT phase,project_id FROM casimir_install.installation WHERE id=1 AND installation_id=${id}`)).rows[0];
 if(install?.phase!=='maintenance')throw new Error('restore_maintenance_required');
 const record=(await ctx.db.execute<{phase:string;kind:string;detail:unknown}>(sql`SELECT phase,kind,detail FROM casimir_install.maintenance WHERE id=${descriptor.recordId}`)).rows[0];
 if(record?.kind!=='backup'||!['quiesced','captured'].includes(record.phase))throw new Error('restore_resume_marker');
 await ctx.engine.closeProxy();await ctx.engine.assertSingleWriter(null);
 const rows=(await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations ORDER BY created_at,id`)).rows;
 if(rows.some(row=>!['succeeded','failed'].includes(String(row.phase))))throw new Error('restore_unresolved_operation');
 const mapping:Array<{operationId:string;sourceImageId:string;imageId:string;sourceContainerId:string|null;containerId:string|null}>=[];
 const work=join(ctx.artifactRoot,'restore-work');await mkdir(work,{recursive:true,mode:0o700});
 for(const row of rows){
  const op=mapMvpOperation(row);if(!op.image_id)continue;
  const artifact=descriptor.artifacts.find((a:any)=>a.id===op.artifact_id);if(!artifact||!/^sealed\/upl_[a-z0-9]{12}\.gz$/.test(artifact.path))throw new Error('restore_artifact_reference');
  const manifest=parseCasimirManifest(artifact.manifest);assertCasimirRuntime(manifest,ctx.profile.runtime);
  const temp=await mkdtemp(join(work,'image-'));
  try{
   const decoded=await extractCasimirArtifact(join(ctx.artifactRoot,artifact.path),join(temp,'payload'),ctx.profile.runtime);
   if(decoded.sha256!==artifact.sha256||canonicalJson(decoded.manifest)!==canonicalJson(manifest))throw new Error('restore_artifact_hash');
   const imageId=await ctx.engine.buildArtifact(join(temp,'payload'),manifest,op);const rebuilt={...op,image_id:imageId};
   const containerId=op.candidate_id?await ctx.engine.createStoppedApp(rebuilt):null;
   mapping.push({operationId:op.id,sourceImageId:op.image_id,imageId,sourceContainerId:op.candidate_id,containerId});
  }finally{await rm(temp,{recursive:true,force:true});}
 }
 const active=(await ctx.db.execute<{active_deployment_id:string}>(sql`SELECT active_deployment_id FROM projects WHERE id=${install.project_id}`)).rows[0];
 const current=rows.map(mapMvpOperation).find(op=>op.deployment_id===active?.active_deployment_id);const rebuiltCurrent=mapping.find(m=>m.operationId===current?.id);
 if(!current||!rebuiltCurrent?.containerId)throw new Error('restore_current_reference');
 assertOperationMappingSize({format:1,phase:'complete',installationId:id,sourceRecord:descriptor.recordId,bundleHash:'0'.repeat(64),mapping});
 const op={...current,image_id:rebuiltCurrent.imageId,candidate_id:rebuiltCurrent.containerId};
 const restoreJob=createHash('sha256').update('restore-native:'+descriptor.recordId).digest('hex').slice(0,32);
 const restored=await runLifecycleJob(ctx,op,'restore',restoreJob,{path:'/snapshots/'+descriptor.snapshot.path,expectedSha256:descriptor.snapshot.sha256});if(restored.ok!==true)throw new Error('restore_native_failed');
 const stateJob=createHash('sha256').update('restore-state:'+descriptor.recordId).digest('hex').slice(0,32);
 const state=await runLifecycleJob(ctx,op,'state',stateJob,{path:'/data/app.sqlite'});
 if(canonicalJson(state.history)!==canonicalJson(descriptor.migrationState.history)||state.schemaDigest!==descriptor.snapshot.schemaDigest)throw new Error('restore_migration_journal');
 for(const retained of descriptor.compatibility){
  const original=rows.map(mapMvpOperation).find(o=>o.id===retained.operationId),mapped=mapping.find(m=>m.operationId===retained.operationId);if(!original||!mapped)throw new Error('restore_compatibility_reference');
  const cloneId=createHash('sha256').update('restore-clone:'+descriptor.recordId+':'+original.id).digest('hex').slice(0,32);
  const clone=await runLifecycleJob(ctx,op,'backup',cloneId,{path:'/snapshots/'+descriptor.snapshot.path,destination:'/snapshots/'+cloneId+'.sqlite'});
  const proofId=createHash('sha256').update('restore-proof:'+descriptor.recordId+':'+original.id).digest('hex').slice(0,32);
  const proof=await runLifecycleJob(ctx,op,'compatibility',proofId,{path:'/snapshots/'+cloneId+'.sqlite',expectedSha256:clone.sha256,expectedSchemaDigest:clone.schemaDigest},{...original,image_id:mapped.imageId});
  if(proof.ok!==true||clone.schemaDigest!==descriptor.snapshot.schemaDigest)throw new Error('restore_retained_compatibility');
 }
 // Commit all pointer substitutions together; never relabel the source archive.
 await ctx.db.transaction(async tx=>{
  ctx.guard.assertLive();
  for(const m of mapping){
   const saved=await tx.execute<{previous_target:Record<string,unknown>|null}>(sql`SELECT previous_target FROM casimir_mvp_a.operations WHERE id=${m.operationId} FOR UPDATE`);let previous=saved.rows[0].previous_target;
   if(previous?.previousOperationId){const mapped=mapping.find(x=>x.operationId===previous!.previousOperationId);if(!mapped?.containerId||!previous.route)throw new Error('restore_previous_mapping');previous={...previous,route:{...(previous.route as Record<string,unknown>),imageId:mapped.imageId,containerId:mapped.containerId}};}
   await tx.execute(sql`UPDATE casimir_mvp_a.operations SET image_id=${m.imageId},candidate_id=${m.containerId},previous_target=${previous?JSON.stringify(previous):null}::jsonb,observation=NULL,updated_at=now() WHERE id=${m.operationId}`);
   await tx.execute(sql`UPDATE casimir_mvp_a.preparations SET image_id=${m.imageId} WHERE operation_id=${m.operationId}`);
  }
  await tx.execute(sql`UPDATE casimir_install.maintenance SET kind='restore',phase='mapped',detail=${JSON.stringify({sourceRecord:descriptor.recordId,mapping})}::jsonb,updated_at=now() WHERE id=${descriptor.recordId}`);
 });
 const route=await ctx.routes.read();await ctx.routes.replace(route,{projectId:op.project_id,deploymentId:op.deployment_id,artifactId:op.artifact_id,imageId:op.image_id,containerId:op.candidate_id});
 await ctx.db.transaction(async tx=>{ctx.guard.assertLive();await tx.execute(sql`UPDATE casimir_install.installation SET phase='stopped',updated_at=now() WHERE id=1 AND phase='maintenance'`);await tx.execute(sql`UPDATE casimir_install.maintenance SET phase='complete',updated_at=now() WHERE id=${descriptor.recordId} AND kind='restore' AND phase='mapped'`);});
 return {outcome:'stopped',code:'restore_mapped_ready_for_explicit_start',installationId:id,mapping};
}
