import {sql} from 'drizzle-orm';
import {canonicalJson} from '@void/deploy-core';
import type {MvpContext} from '../mvp/runner.ts';
import type {MvpOperation} from '../mvp/types.ts';
type JobRecord={id:string;action:string;releaseId:string;parameters:Record<string,unknown>};
export function appendLifecycleJob(previous:Record<string,unknown>|null,record:JobRecord){
 const journal=previous??{route:null,previousOperationId:null};
 if(journal.jobs!==undefined&&(!journal.jobs||typeof journal.jobs!=='object'||Array.isArray(journal.jobs)))throw new Error('job_journal_invalid');
 const jobs={...(journal.jobs as Record<string,unknown>??{})},key='lifecycle-'+record.id;
 if(jobs[key]&&canonicalJson(jobs[key])!==canonicalJson(record))throw new Error('lifecycle_job_conflict');
 jobs[key]=record;return {...journal,jobs};
}
export async function runLifecycleJob(ctx:MvpContext,op:MvpOperation,action:string,id:string,parameters:Record<string,unknown>,release:MvpOperation=op){
 ctx.guard.assertLive();
 await ctx.db.transaction(async tx=>{
  const installation=await tx.execute<{phase:string}>(sql`SELECT phase FROM casimir_install.installation WHERE id=1 AND installation_id=${ctx.profile.installationId} FOR UPDATE`);
  if(installation.rows[0]?.phase!=='maintenance')throw new Error('maintenance_required');
  const rows=await tx.execute<{previous_target:Record<string,unknown>|null}>(sql`SELECT previous_target FROM casimir_mvp_a.operations WHERE id=${op.id} AND project_id=${op.project_id} FOR UPDATE`);
  if(rows.rows.length!==1||release.project_id!==op.project_id)throw new Error('lifecycle_job_operation');
  const next=appendLifecycleJob(rows.rows[0].previous_target,{id,action,releaseId:release.id,parameters});
  ctx.guard.assertLive();await tx.execute(sql`UPDATE casimir_mvp_a.operations SET previous_target=${JSON.stringify(next)}::jsonb,updated_at=now() WHERE id=${op.id}`);
 });
 // A journal-only interruption is harmless: cleanup sees no container. A created
 // or completed job is reconciled by the exact existing recipe on retry; after
 // successful resume the normal guarded terminal-job cleanup removes it.
 return ctx.engine.runJob(op,action,id,parameters,release);
}
