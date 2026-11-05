import {runLifecycleJob} from './job-journal.ts';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import type {Db} from '../../db/client.ts';
import type {MvpContext} from '../mvp/runner.ts';
import {quiesceInstallation} from './quiesce.ts';
import {retainedReleases} from './retention.ts';
import {mapMvpOperation} from '../mvp/store.ts';
/**
 * Once the API and executor have exited, discard transient upload staging for
 * this installation. Finalized artifact rows and sealed files remain intact.
 * State commits before file removal so retries can safely finish cleanup.
 */
export async function cancelUnfinalizedUploadsForBackup(
 db:Db,installationId:string,projectId:string,recordId:string,artifactRoot:string,assertLive:()=>void=()=>{}
):Promise<number>{
 assertLive();
 const ids=await db.transaction(async tx=>{
  const installation=(await tx.execute<{installation_id:string;project_id:string;phase:string}>(sql`SELECT installation_id,project_id,phase FROM casimir_install.installation WHERE id=1 FOR UPDATE`)).rows[0];
  if(installation?.installation_id!==installationId||installation.project_id!==projectId||installation.phase!=='maintenance')throw new Error('backup_upload_cancel_maintenance');
  const scope=(await tx.execute<{project_id:string|null}>(sql`SELECT project_id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`)).rows[0];
  if(scope?.project_id!==projectId)throw new Error('backup_upload_cancel_scope');
  const maintenance=(await tx.execute<{kind:string;phase:string}>(sql`SELECT kind,phase FROM casimir_install.maintenance WHERE id=${recordId} AND installation_id=${installationId} FOR UPDATE`)).rows[0];
  if(maintenance?.kind!=='backup'||maintenance.phase!=='quiesced')throw new Error('backup_upload_cancel_phase');
  const rows=(await tx.execute<{id:string;state:string;artifact_id:string|null}>(sql`SELECT u.id,u.state,a.id AS artifact_id FROM casimir_mvp_a.uploads u LEFT JOIN casimir_mvp_a.artifacts a ON a.upload_id=u.id WHERE u.project_id=${projectId} ORDER BY u.id FOR UPDATE OF u`)).rows;
  for(const row of rows){
   if(!/^upl_[a-z0-9]{12}$/.test(row.id))throw new Error('backup_upload_cancel_id');
   if(row.state==='finalized'&&!row.artifact_id)throw new Error('backup_upload_finalized_without_artifact');
   if(row.state!=='finalized'&&row.artifact_id)throw new Error('backup_upload_artifact_state_mismatch');
  }
  assertLive();
  const changed=await tx.execute<{id:string}>(sql`UPDATE casimir_mvp_a.uploads SET state='failed' WHERE project_id=${projectId} AND state<>'finalized' RETURNING id`);
  return changed.rows.map(row=>row.id);
 });
 const staging=join(artifactRoot,'staging');
 for(const id of ids){assertLive();await rm(join(staging,id+'.gz'),{force:true});}
 return ids.length;
}
// Capture only after the durable admission gate and zero-writer proof. The
// external archive job consumes this exact reference inventory, never live data.
export async function prepareBackupCapture(ctx:MvpContext){
 const quiesced=await quiesceInstallation(ctx,'backup');
 const op=quiesced.operation;if(!op)throw new Error('backup_requires_deployed_reference');
 await cancelUnfinalizedUploadsForBackup(ctx.db,ctx.profile.installationId!,op.project_id,quiesced.recordId,ctx.artifactRoot,()=>ctx.guard.assertLive());
 const jobId=createHash('sha256').update('installation-backup:'+quiesced.recordId).digest('hex').slice(0,32);
 const snapshot=await runLifecycleJob(ctx,op,'backup',jobId,{path:'/data/app.sqlite',destination:'/snapshots/'+jobId+'.sqlite'});
 if(snapshot.ok!==true||typeof snapshot.sha256!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.sha256)||typeof snapshot.schemaDigest!=='string')throw new Error('native_backup_invalid');
 const artifacts=(await ctx.db.execute<{id:string;path:string;sha256:string;bytes:string;manifest:unknown;runtime:unknown}>(sql`SELECT id,path,sha256,bytes,manifest,runtime FROM casimir_mvp_a.artifacts ORDER BY id`)).rows;
 for(const artifact of artifacts){
  if(!/^sealed\/upl_[a-z0-9]+\.gz$/.test(artifact.path))throw new Error('artifact_reference_path');
  const path=join(ctx.artifactRoot,artifact.path),info=await lstat(path);if(!info.isFile()||info.size!==Number(artifact.bytes))throw new Error('artifact_reference_missing');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==artifact.sha256)throw new Error('artifact_reference_hash');
 }
 const operations=(await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations ORDER BY created_at,id`)).rows;
 for(const operation of operations)if(!artifacts.some(a=>a.id===operation.artifact_id))throw new Error('operation_artifact_missing');
 const stateId=createHash('sha256').update('installation-backup-state:'+quiesced.recordId).digest('hex').slice(0,32);
 const migrationState=await runLifecycleJob(ctx,op,'state',stateId,{path:'/snapshots/'+jobId+'.sqlite'});
 const manifest=artifacts.find(a=>a.id===op.artifact_id)?.manifest as {migrations?:Array<{name:string;sha256:string}>};
 if(JSON.stringify(migrationState.history)!==JSON.stringify(manifest?.migrations?.map(({name,sha256})=>({name,sha256})))||migrationState.schemaDigest!==snapshot.schemaDigest)throw new Error('snapshot_migration_journal');
 const retained=retainedReleases(op,operations.map(mapMvpOperation));
 const compatibility=[];
 for(const release of retained){
  const cloneId=createHash('sha256').update('backup-clone:'+quiesced.recordId+':'+release.id).digest('hex').slice(0,32);
  const clone=await runLifecycleJob(ctx,op,'backup',cloneId,{path:'/snapshots/'+jobId+'.sqlite',destination:'/snapshots/'+cloneId+'.sqlite'});
  const proofId=createHash('sha256').update('backup-compatibility:'+quiesced.recordId+':'+release.id).digest('hex').slice(0,32);
  const proof=await runLifecycleJob(ctx,op,'compatibility',proofId,{path:'/snapshots/'+cloneId+'.sqlite',expectedSha256:clone.sha256,expectedSchemaDigest:clone.schemaDigest},release);
  if(proof.ok!==true||clone.schemaDigest!==snapshot.schemaDigest)throw new Error('retained_backup_compatibility');compatibility.push({operationId:release.id,imageId:release.image_id,snapshotSha256:clone.sha256,schemaDigest:clone.schemaDigest});
 }
 const descriptor={format:1,recordId:quiesced.recordId,installationId:ctx.profile.installationId,runtime:ctx.profile.runtime,snapshot:{path:jobId+'.sqlite',sha256:snapshot.sha256,schemaDigest:snapshot.schemaDigest},migrationState,compatibility,currentOperation:op.id,artifacts,operations,restoreResume:{sourcePhase:'maintenance',sourceKind:'backup',recordId:quiesced.recordId}};
 ctx.guard.assertLive();await ctx.db.execute(sql`UPDATE casimir_install.maintenance SET detail=${JSON.stringify(descriptor)}::jsonb,updated_at=now() WHERE id=${quiesced.recordId} AND phase='quiesced'`);
 return descriptor;
}
