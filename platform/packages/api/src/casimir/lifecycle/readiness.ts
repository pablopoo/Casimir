import {sql} from 'drizzle-orm';
import {assertControlSchema} from './control-migrations.ts';
import type {MvpContext} from '../mvp/runner.ts';
import {assertMvpMigrations,mapMvpOperation} from '../mvp/store.ts';
import type {LifecycleResult} from './types.ts';
import {inspectIngressPublication} from './ingress-readiness.ts';
export async function inspectInstallationReadiness(ctx:Pick<MvpContext,'db'|'engine'|'profile'|'routes'>,ca?:Buffer):Promise<LifecycleResult>{
 const installationId=ctx.profile.installationId!;
 const rows=await ctx.db.execute<{installation_id:string;project_id:string;phase:string;bundle_version:string}>(sql`SELECT * FROM casimir_install.installation WHERE id=1`);
 const install=rows.rows[0];if(install?.installation_id!==installationId)throw new Error('installation_identity');
 const base={installationId,bundleVersion:install.bundle_version};
 if(install.phase!=='ready')return {...base,outcome:install.phase==='stopped'?'stopped':'blocked',code:install.phase};
 try{
  await assertMvpMigrations(ctx.db);
  await assertControlSchema(ctx.db,install.bundle_version);
  await ctx.engine.verifyEnvironment();
  const ingress=await inspectIngressPublication(ctx.engine,ctx.profile.origins!,ca,ctx.profile.externalTls);
  const guards=await ctx.db.execute<{container_id:string;started_at:string}>(sql`SELECT container_id,started_at FROM casimir_mvp_a.executor_guard WHERE scope='casimir-mvp-a'`);
  const guard=guards.rows[0],container=guard&&await ctx.engine.inspectContainer(guard.container_id);
  if(!container?.State.Running||container.State.StartedAt!==guard.started_at||container.Config?.Labels?.['org.casimir.role']!=='executor')throw new Error('executor_unavailable');
  // The fixed session lock must still be held; a running container alone is not a live executor.
  const held=await ctx.db.execute<{held:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1128354643 AND objid=5 AND granted) AS held`);
  if(!held.rows[0]?.held)throw new Error('executor_unguarded');
  const pending=await ctx.db.execute(sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`);
  if(pending.rows.length)return {...base,outcome:'blocked',code:'operation_not_terminal'};
  const projects=await ctx.db.execute<{active_deployment_id:string|null}>(sql`SELECT active_deployment_id FROM projects WHERE id=${install.project_id}`);
  if(!projects.rows[0])throw new Error('project_missing');
  const route=await ctx.routes.read(),active=projects.rows[0].active_deployment_id;
  if(!active){if(route.target||ingress.app.status!==503)throw new Error('route_conflict');await ctx.engine.inspectSingleWriter(null);return {...base,outcome:'ready',code:'ready_to_deploy'};}
  const operations=await ctx.db.execute(sql`SELECT * FROM casimir_mvp_a.operations WHERE deployment_id=${active} AND phase='succeeded'`);
  if(operations.rows.length!==1)throw new Error('operation_missing');
  const op=mapMvpOperation(operations.rows[0]);
  if(ingress.app.status>=500||ingress.app.headers['x-casimir-deployment']!==op.deployment_id||ingress.app.headers['x-casimir-image']!==op.image_id)throw new Error('tls_serving_identity');
  if(!route.target||route.target.deploymentId!==active||route.target.containerId!==op.candidate_id||route.target.imageId!==op.image_id||route.target.artifactId!==op.artifact_id)throw new Error('route_conflict');
  await ctx.engine.inspectPreparedImage(op.image_id!,op);await ctx.engine.inspectSingleWriter(op);await ctx.engine.inspectIngress(op);
  return {...base,outcome:'ready',code:'serving_verified',servingObservation:{project:op.project_id,deployment:op.deployment_id,imageId:op.image_id!,observedAt:new Date().toISOString()}};
 }catch{return {...base,outcome:'blocked',code:'readiness_verification_failed'};}
}
