import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {MvpContext} from '../mvp/runner.ts';
import {mapMvpOperation} from '../mvp/store.ts';
import {retainedReleases} from './retention.ts';
import {runLifecycleJob} from './job-journal.ts';
import {reconcileInstallationStartup} from './startup.ts';
import {applyControlUpgrade,type UpgradeIntent} from './upgrade.ts';
import {assertControlSchema} from './control-migrations.ts';
export async function upgradeInstallationRuntime(ctx:MvpContext,intent:UpgradeIntent,expose:boolean){
 if(intent.installationId!==ctx.profile.installationId)throw new Error('upgrade_installation_identity');
 ctx.guard.assertLive();
 const record=(await ctx.db.execute<{phase:string}>(sql`SELECT phase FROM casimir_install.maintenance WHERE id=${intent.id} AND installation_id=${intent.installationId} AND kind='upgrade'`)).rows[0];
 if(record?.phase==='complete')throw new Error('upgrade_already_complete');
 if(record?.phase!=='exposure_started')await ctx.engine.assertSingleWriter(null);
 const current=await applyControlUpgrade(ctx.db,intent,()=>ctx.guard.assertLive());
 if(current.phase==='migrated'){
  const backup=(await ctx.db.execute<{detail:{currentOperation:string;snapshot:{path:string;sha256:string;schemaDigest:string}}}>(sql`SELECT detail FROM casimir_install.maintenance WHERE id=${intent.backupRecordId} AND phase='verified' AND inventory_hash=${intent.backupHash}`)).rows[0]?.detail;
  if(!backup||!/^[a-f0-9]{32}\.sqlite$/.test(backup.snapshot.path))throw new Error('upgrade_backup_descriptor');
  const operations=(await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations ORDER BY created_at,id`)).rows.map(mapMvpOperation),op=operations.find(o=>o.id===backup.currentOperation);
  if(!op||op.phase!=='succeeded')throw new Error('upgrade_current_operation');
  for(const release of retainedReleases(op,operations)){
   const id=createHash('sha256').update('upgrade-clone:'+intent.id+':'+release.id).digest('hex').slice(0,32);
   const clone=await runLifecycleJob(ctx,op,'backup',id,{path:'/snapshots/'+backup.snapshot.path,destination:'/snapshots/'+id+'.sqlite'});
   if(clone.sha256!==backup.snapshot.sha256||clone.schemaDigest!==backup.snapshot.schemaDigest)throw new Error('upgrade_snapshot_changed');
   const proofId=createHash('sha256').update('upgrade-proof:'+intent.id+':'+release.id).digest('hex').slice(0,32);
   const proof=await runLifecycleJob(ctx,op,'compatibility',proofId,{path:'/snapshots/'+id+'.sqlite',expectedSha256:clone.sha256,expectedSchemaDigest:clone.schemaDigest},release);
   if(proof.ok!==true)throw new Error('upgrade_native_compatibility');
  }
  ctx.guard.assertLive();await ctx.db.execute(sql`UPDATE casimir_install.maintenance SET phase='compatibility_verified',updated_at=now() WHERE id=${intent.id} AND phase='migrated'`);
 }
 if(!expose)return {outcome:'blocked',code:'upgrade_compatibility_verified',operationId:intent.id};
 // Once exposure can occur, retries must never rerun migration or restore data.
 ctx.guard.assertLive();await ctx.db.execute(sql`UPDATE casimir_install.maintenance SET phase='exposure_started',updated_at=now() WHERE id=${intent.id} AND phase='compatibility_verified'`);
 await assertControlSchema(ctx.db,intent.target.version);
 const result=await reconcileInstallationStartup(ctx,{resumeVerifiedBackup:true});
 if(result.outcome!=='ready')return result;
 await ctx.db.transaction(async tx=>{
  ctx.guard.assertLive();const changed=await tx.execute(sql`UPDATE casimir_install.installation SET phase='ready',updated_at=now() WHERE id=1 AND installation_id=${intent.installationId} AND bundle_version=${intent.target.version} AND phase='maintenance' RETURNING id`);
  if(changed.rows.length!==1)throw new Error('upgrade_finish_state');
  await tx.execute(sql`UPDATE casimir_install.maintenance SET phase='complete',updated_at=now() WHERE id IN (${intent.id},${intent.backupRecordId})`);
 });return result;
}
