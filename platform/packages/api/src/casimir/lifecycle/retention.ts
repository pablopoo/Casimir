type ReleaseReference={id:string;deployment_id:string;previous_target?:Record<string,unknown>|null};
/** previous_target is the operation journal, not the previous route itself. */
export function retainedReleases<T extends ReleaseReference>(current:T,operations:T[]):T[]{
 const journal=current.previous_target;
 if(!journal)return [current];
 const previousId=journal.previousOperationId,route=journal.route as {deploymentId?:string}|null|undefined;
 if(previousId===null&&!route)return [current];
 const prior=operations.find(op=>op.id===previousId);
 if(typeof previousId!=='string'||!prior||prior.id===current.id)throw new Error('previous_operation_missing');
 if(!route||route.deploymentId!==prior.deployment_id)throw new Error('previous_route_mismatch');
 return [current,prior];
}
type RetainedOperation=ReleaseReference&{phase:string;image_id:string|null;candidate_id?:string|null;artifact_id?:string};
export function retentionReferences(current:RetainedOperation|undefined,operations:RetainedOperation[],backups:Array<{id:string;operations:string[]}>){
 const currentIds=current?retainedReleases(current,operations).map(op=>op.id):[];
 return operations.filter(op=>op.image_id).map(op=>{
  const reasons:string[]=[];if(op.id===currentIds[0])reasons.push('current');if(op.id===currentIds[1])reasons.push('previous');
  if(op.phase==='recovery_required')reasons.push('blocked');else if(!['succeeded','failed'].includes(op.phase))reasons.push('pending');
  for(const backup of backups)if(backup.operations.includes(op.id))reasons.push('backup:'+backup.id);
  if(!reasons.length)reasons.push('operation_history');
  return {resource:op.image_id!,operationId:op.id,containerId:op.candidate_id??null,artifactId:op.artifact_id??null,reasons};
 });
}
