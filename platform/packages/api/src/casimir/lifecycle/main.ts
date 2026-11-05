import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createDb} from '../../db/client.ts';
import {MvpEngine} from '../mvp/engine.ts';
import {loadMvpProfile} from '../mvp/profile.ts';
import {MvpRouteStore} from '../mvp/routing.ts';
import {inspectInstallationReadiness} from './readiness.ts';
import {hostname} from 'node:os';
import {sql} from 'drizzle-orm';
import {beginInstallationMaintenance} from './maintenance.ts';
import {quiesceInstallation} from './quiesce.ts';
import {reconcileInstallationStartup} from './startup.ts';
import {prepareBackupCapture} from './backup.ts';
import {restoreInstallationRuntime} from './restore.ts';
import {upgradeInstallationRuntime} from './upgrade-runtime.ts';
import {retentionInventory} from './retention-inventory.ts';
import {acquireExecutorGuard,type ExecutorGuard} from '../execution/guard.ts';
let pool:Pool|undefined,guard:ExecutorGuard|undefined;
try{
 const [command]=process.argv.slice(2);
 if((!['upgrade-status','upgrade-prepare','upgrade-expose','status','retention-inventory','request-stop','request-backup','drain-status','finish-stop','finish-start','capture-backup','mark-backup-captured','restore-runtime'].includes(command)&&!/^mark-backup-verified:[a-f0-9]{64}$/.test(command))||process.argv.length!==3)throw new Error('unsupported_operator_job');
 if(!process.env.DATABASE_URL||!process.env.CASIMIR_MVP_PROFILE)throw new Error('operator_configuration');
 const profile=loadMvpProfile(process.env.CASIMIR_MVP_PROFILE);
 if(!profile.installationId)throw new Error('installation_required');
 const runner=JSON.parse(await readFile('/config/runner.json','utf8'));
 const engine=new MvpEngine({socketPath:'/var/run/docker.sock',runnerImage:runner.imageId,runtime:profile.runtime,installationId:profile.installationId,appOrigin:profile.origins?.app});
 pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000,query_timeout:5000,statement_timeout:5000,max:3});
 const db=createDb(pool),routes=new MvpRouteStore('/routes');
 let result:unknown;
 if(command==='upgrade-status'){const intent=JSON.parse(await readFile('/upgrade/intent.json','utf8'));if(intent.installationId!==profile.installationId)throw new Error('upgrade_installation_identity');result=(await db.execute(sql`SELECT id,phase FROM casimir_install.maintenance WHERE id=${intent.id} AND installation_id=${profile.installationId} AND kind='upgrade'`)).rows[0]??{phase:'pending'};}
 else if(command==='retention-inventory')result=await retentionInventory(db,profile.installationId);
 else if(command==='status')result=await inspectInstallationReadiness({db,engine,profile,routes},profile.origins?.control.startsWith('https:')?await readFile('/config/ca.pem'):undefined);
 else {
  const installation=(await db.execute<{bundle_version:string;phase:string}>(sql`SELECT bundle_version,phase FROM casimir_install.installation WHERE id=1 AND installation_id=${profile.installationId}`)).rows[0];
  if(!installation)throw new Error('installation_identity');
  if(command==='request-stop')result=await beginInstallationMaintenance(db,profile.installationId,'stop',installation.bundle_version);
  if(command==='request-backup')result=await beginInstallationMaintenance(db,profile.installationId,'backup',installation.bundle_version);
  if(command==='mark-backup-captured'||command.startsWith('mark-backup-verified:')){
   if(installation.phase!=='maintenance')throw new Error('maintenance_required');
   const phase=command==='mark-backup-captured'?'captured':'verified',hash=command.startsWith('mark-backup-verified:')?command.split(':')[1]:null;
   const changed=await db.execute(sql`UPDATE casimir_install.maintenance SET phase=${phase},inventory_hash=COALESCE(${hash},inventory_hash),updated_at=now() WHERE installation_id=${profile.installationId} AND kind='backup' AND phase IN ('quiesced','captured') RETURNING id`);
   if(changed.rows.length!==1)throw new Error('backup_phase');result={phase,id:changed.rows[0].id};
  }
  if(command==='drain-status'){
   if(installation.phase!=='maintenance')throw new Error('maintenance_required');
   const pending=await db.execute(sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`);
   result={drained:pending.rows.length===0};
  }
  if(command==='upgrade-prepare'||command==='upgrade-expose'||command==='finish-stop'||command==='finish-start'||command==='capture-backup'||command==='restore-runtime'){
   const self=await engine.inspectContainer(hostname());
   if(!self?.State.Running||self.Config?.Labels?.['org.casimir.role']!=='operator')throw new Error('operator_identity');
   guard=await acquireExecutorGuard({connectionString:process.env.DATABASE_URL,engine,selfContainerId:self.Id,selfStartedAt:self.State.StartedAt,guardProfile:'mvp-a'});engine.setGuard(guard);
   const ctx={db,engine,profile,routes,guard,artifactRoot:profile.artifactRoot,failpoint:async()=>{}};
   if(command==='upgrade-prepare'||command==='upgrade-expose')result=await upgradeInstallationRuntime(ctx,JSON.parse(await readFile('/upgrade/intent.json','utf8')),command==='upgrade-expose');
   else if(command==='restore-runtime')result=await restoreInstallationRuntime(ctx,JSON.parse(await readFile('/restore/descriptor.json','utf8')));
   else if(command==='capture-backup')result=await prepareBackupCapture(ctx);
   else if(command==='finish-start'){
    let backupId:string|undefined;
    if(installation.phase==='maintenance'){
     const records=await db.execute<{id:string;kind:string;phase:string}>(sql`SELECT id,kind,phase FROM casimir_install.maintenance WHERE installation_id=${profile.installationId} AND phase<>'complete'`);
     if(records.rows.length!==1||records.rows[0].kind!=='backup'||records.rows[0].phase!=='verified')throw new Error('verified_backup_required');backupId=records.rows[0].id;
    }else if(installation.phase!=='stopped')throw new Error('stopped_installation_required');
    result=await reconcileInstallationStartup(ctx,{resumeStopped:true,resumeVerifiedBackup:!!backupId});
    if((result as {outcome:string}).outcome==='ready'){
     guard.assertLive();await db.transaction(async tx=>{await tx.execute(sql`UPDATE casimir_install.installation SET phase='ready',updated_at=now() WHERE id=1 AND phase=${installation.phase}`);if(backupId)await tx.execute(sql`UPDATE casimir_install.maintenance SET phase='complete',updated_at=now() WHERE id=${backupId} AND phase='verified'`);});
    }
   }else{
   const quiesced=await quiesceInstallation(ctx,'stop');
   await db.transaction(async tx=>{
    guard!.assertLive();await tx.execute(sql`UPDATE casimir_install.installation SET phase='stopped',updated_at=now() WHERE id=1 AND phase='maintenance'`);
    await tx.execute(sql`UPDATE casimir_install.maintenance SET phase='complete',updated_at=now() WHERE id=${quiesced.recordId} AND phase='quiesced'`);
   });
   result={outcome:'stopped',code:'operator_stopped',installationId:profile.installationId,bundleVersion:installation.bundle_version,operationId:quiesced.recordId};
   }
  }
 }
 console.log(JSON.stringify(result));
}catch(error){const code=error instanceof Error&&/^[a-z_][a-z0-9_]{0,95}$/.test(error.message)?error.message:'operator_job_failed';console.error(code);process.exitCode=1;}finally{await guard?.close();await pool?.end();}
