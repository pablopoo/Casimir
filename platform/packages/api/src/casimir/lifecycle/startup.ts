import {sql} from 'drizzle-orm';
import type {MvpContext} from '../mvp/runner.ts';
import {mapMvpOperation} from '../mvp/store.ts';
import type {LifecycleResult} from './types.ts';
export async function reconcileInstallationStartup(ctx:MvpContext,options:{resumeStopped?:boolean;resumeVerifiedBackup?:boolean}={}):Promise<LifecycleResult>{
 const installationId=ctx.profile.installationId!;ctx.guard.assertLive();
 // Close the live ingress independently of its persisted route. Recovery still
 // needs the original journal/route to determine whether exposure occurred.
 await ctx.engine.closeProxy();
 const rows=await ctx.db.execute<{installation_id:string;project_id:string;phase:string;bundle_version:string}>(sql`SELECT * FROM casimir_install.installation WHERE id=1`);
 const install=rows.rows[0];if(install?.installation_id!==installationId)throw new Error('installation_identity');
 const base={installationId,bundleVersion:install.bundle_version};
 if(install.phase!=='ready'&&!(options.resumeStopped&&install.phase==='stopped')&&!(options.resumeVerifiedBackup&&install.phase==='maintenance'))return {...base,outcome:'blocked',code:install.phase};
 const pending=await ctx.db.execute<{phase:string}>(sql`SELECT phase FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`);
 if(pending.rows[0])return {...base,outcome:'blocked',code:pending.rows[0].phase==='recovery_required'?'recovery_required':'operation_reconciliation_pending'};
 try{
  const projects=await ctx.db.execute<{active_deployment_id:string|null}>(sql`SELECT active_deployment_id FROM projects WHERE id=${install.project_id}`);
  if(!projects.rows[0])throw new Error('project_missing');
  const route=await ctx.routes.read(),active=projects.rows[0].active_deployment_id;
  if(!active){if(route.target)throw new Error('route_pointer_conflict');await ctx.engine.assertSingleWriter(null);return {...base,outcome:'ready',code:'ready_to_deploy'};}
  const operations=await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations WHERE deployment_id=${active} AND phase='succeeded'`);
  if(operations.rows.length!==1)throw new Error('serving_operation_missing');
  const op=mapMvpOperation(operations.rows[0]);
  const expected={projectId:op.project_id,deploymentId:op.deployment_id,artifactId:op.artifact_id,containerId:op.candidate_id!,imageId:op.image_id!};
  if(!route.target||Object.entries(expected).some(([k,v])=>route.target?.[k as keyof typeof expected]!==v))throw new Error('route_pointer_conflict');
  const c=await ctx.engine.inspectContainer(op.candidate_id!);if(!c)throw new Error('current_container_missing');
  await ctx.engine.assertSingleWriter(c.State.Running?op:null);
  if(await ctx.engine.startApp(op)!==op.candidate_id)throw new Error('container_incarnation_conflict');
  await ctx.engine.privateProbe(op,op.candidate_id!);await ctx.engine.assertSingleWriter(op);await ctx.engine.reloadProxy();await ctx.engine.observeIngress(op);
  const observation={project:op.project_id,deployment:op.deployment_id,imageId:op.image_id!,observedAt:new Date().toISOString()};
  await ctx.db.execute(sql`UPDATE casimir_mvp_a.operations SET observation=${JSON.stringify({deploymentId:op.deployment_id,artifactId:op.artifact_id,imageId:op.image_id,observedAt:observation.observedAt})}::jsonb,updated_at=now() WHERE id=${op.id}`);
  return {...base,outcome:'ready',code:'serving_verified',servingObservation:observation};
 }catch{
  await ctx.engine.closeProxy();await ctx.db.execute(sql`UPDATE casimir_install.installation SET phase='recovery_required',updated_at=now() WHERE id=1`);return {...base,outcome:'blocked',code:'startup_recovery_required'};
 }
}
