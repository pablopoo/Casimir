import {sql} from 'drizzle-orm';
import type {MvpContext} from '../mvp/runner.ts';
import {mapMvpOperation} from '../mvp/store.ts';
import type {MaintenanceRecord} from './types.ts';
export async function quiesceInstallation(ctx:MvpContext,kind:MaintenanceRecord['kind']){
 ctx.guard.assertLive();const id=ctx.profile.installationId!;
 const installation=await ctx.db.execute<{phase:string;project_id:string}>(sql`SELECT phase,project_id FROM casimir_install.installation WHERE id=1 AND installation_id=${id}`);
 if(installation.rows[0]?.phase!=='maintenance')throw new Error('maintenance_required');
 const records=await ctx.db.execute<{id:string;kind:string;phase:string}>(sql`SELECT id,kind,phase FROM casimir_install.maintenance WHERE installation_id=${id} AND phase<>'complete' ORDER BY created_at DESC LIMIT 1`);
 const record=records.rows[0];if(!record||record.kind!==kind||!['requested','quiesced'].includes(record.phase))throw new Error('maintenance_phase');
 const unresolved=await ctx.db.execute(sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`);
 if(unresolved.rows.length)throw new Error('unresolved_operation_refused');
 await ctx.engine.closeProxy();
 const current=await ctx.db.execute(sql`SELECT o.* FROM projects p JOIN casimir_mvp_a.operations o ON o.deployment_id=p.active_deployment_id WHERE p.id=${installation.rows[0].project_id} AND o.phase='succeeded'`);
 const op=current.rows[0]?mapMvpOperation(current.rows[0]):null;
 if(current.rows.length>1)throw new Error('active_operation_conflict');
 if(op){if(!op.candidate_id)throw new Error('active_container_missing');await ctx.engine.stopApp(op,op.candidate_id);}
 await ctx.engine.assertSingleWriter(null);ctx.guard.assertLive();
 await ctx.db.execute(sql`UPDATE casimir_install.maintenance SET phase='quiesced',updated_at=now() WHERE id=${record.id} AND phase IN ('requested','quiesced')`);
 return {recordId:record.id,operation:op};
}
