import {sql} from 'drizzle-orm';
import type {Db,DbOrTx} from '../../db/client.ts';
import {OPERATION_INVENTORY_MAX_BYTES} from './identity.ts';
import {retentionReferences} from './retention.ts';

const MAX_OPERATION_ROWS=2048;
const MAX_BACKUP_ROWS=256;
type OperationRow={id:string;deployment_id:string;phase:string;image_id:string|null;candidate_id:string|null;artifact_id:string;previous_target:Record<string,unknown>|null};
type BackupRow={id:string;operation_count:number;operation_ids:string[];invalid_operation_ids:boolean};
type InventoryRows={installation:{project_id:string};activeDeploymentId:string|null;operations:OperationRow[];backups:BackupRow[]};
type Reservation={additionalOperations?:number;additionalBackups?:number};

export function assertOperationInventorySize(value:unknown):number{
 const bytes=Buffer.byteLength(JSON.stringify(value)+'\n');
 if(bytes>OPERATION_INVENTORY_MAX_BYTES)throw new Error('retention_inventory_size_limit');
 return bytes;
}

export function assertOperationMappingSize(value:unknown):number{
 const bytes=Buffer.byteLength(JSON.stringify(value)+'\n');
 if(bytes>OPERATION_INVENTORY_MAX_BYTES)throw new Error('operation_mapping_size_limit');
 return bytes;
}

async function readInventoryRows(tx:DbOrTx,installationId:string):Promise<InventoryRows>{
 const installation=(await tx.execute<{installation_id:string;project_id:string}>(sql`SELECT installation_id,project_id FROM casimir_install.installation WHERE id=1 FOR SHARE`)).rows[0];
 if(installation?.installation_id!==installationId)throw new Error('installation_identity');
 await tx.execute(sql`SELECT id FROM casimir_mvp_a.scope WHERE id=1 FOR SHARE`);
 const active=(await tx.execute<{active_deployment_id:string|null}>(sql`SELECT active_deployment_id FROM projects WHERE id=${installation.project_id}`)).rows[0];
 const activeDeploymentId=active?.active_deployment_id??null;
 const rawOperations=(await tx.execute<OperationRow&{previous_target_bytes:number}>(sql`SELECT id,deployment_id,phase,image_id,candidate_id,artifact_id,
  CASE WHEN deployment_id=${activeDeploymentId} AND COALESCE(octet_length(previous_target::text),0)<=${OPERATION_INVENTORY_MAX_BYTES} THEN previous_target ELSE NULL END AS previous_target,
  CASE WHEN deployment_id=${activeDeploymentId} THEN COALESCE(octet_length(previous_target::text),0) ELSE 0 END AS previous_target_bytes
  FROM casimir_mvp_a.operations ORDER BY created_at,id LIMIT ${MAX_OPERATION_ROWS+1}`)).rows;
 if(rawOperations.some(op=>op.previous_target_bytes>OPERATION_INVENTORY_MAX_BYTES))throw new Error('retention_inventory_size_limit');
 const operations=rawOperations;
 if(operations.length>MAX_OPERATION_ROWS)throw new Error('retention_inventory_operation_limit');
 const backups=(await tx.execute<BackupRow>(sql`SELECT id,
  CASE WHEN detail ? 'operations' AND jsonb_typeof(detail->'operations') IS DISTINCT FROM 'array' THEN -1
   WHEN jsonb_typeof(detail->'operations')='array' THEN jsonb_array_length(detail->'operations') ELSE 0 END AS operation_count,
  CASE WHEN jsonb_typeof(detail->'operations')='array' AND jsonb_array_length(detail->'operations')<=${MAX_OPERATION_ROWS}
   THEN COALESCE((SELECT jsonb_agg(CASE WHEN jsonb_typeof(item->'id')='string' AND length(item->>'id')<=64 THEN to_jsonb(item->>'id') ELSE to_jsonb(''::text) END) FROM jsonb_array_elements(detail->'operations') AS entries(item)),'[]'::jsonb)
   ELSE '[]'::jsonb END AS operation_ids,
  CASE WHEN detail ? 'operations' AND jsonb_typeof(detail->'operations') IS DISTINCT FROM 'array' THEN true
   WHEN jsonb_typeof(detail->'operations')='array' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(detail->'operations') AS entries(item) WHERE jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(item->>'id')>64)
   ELSE false END AS invalid_operation_ids
  FROM casimir_install.maintenance WHERE kind='backup' AND inventory_hash IS NOT NULL ORDER BY created_at,id LIMIT ${MAX_BACKUP_ROWS+1}`)).rows;
 if(backups.length>MAX_BACKUP_ROWS)throw new Error('retention_inventory_backup_limit');
 if(backups.some(backup=>backup.operation_count<0||backup.operation_count>MAX_OPERATION_ROWS||backup.invalid_operation_ids))throw new Error('retention_inventory_size_limit');
 return {installation,activeDeploymentId,operations,backups};
}

function inventoryValue(rows:InventoryRows,installationId:string,observedAt:string){
 return {
  format:1,
  installationId,
  observedAt,
  references:retentionReferences(
   rows.operations.find(op=>op.deployment_id===rows.activeDeploymentId),
   rows.operations,
   rows.backups.map(b=>({id:b.id,operations:b.operation_ids})),
  ),
  backups:rows.backups.map(b=>b.id),
 };
}

function assertProjectedInventorySize(rows:InventoryRows,installationId:string,observedAt:string,reservation:Reservation={}):void{
 const additionalOperations=reservation.additionalOperations??0,additionalBackups=reservation.additionalBackups??0;
 if(!Number.isInteger(additionalOperations)||additionalOperations<0||!Number.isInteger(additionalBackups)||additionalBackups<0)throw new Error('retention_inventory_reservation_invalid');
 if(rows.operations.length+additionalOperations>MAX_OPERATION_ROWS)throw new Error('retention_inventory_operation_limit');
 if(rows.backups.length+additionalBackups>MAX_BACKUP_ROWS)throw new Error('retention_inventory_backup_limit');

 const projectedBackups=[...rows.backups.map(b=>b.id),...Array.from({length:additionalBackups},()=> 'x'.repeat(32))];
 const base={format:1,installationId,observedAt,references:[],backups:projectedBackups};
 let inventoryBytes=Buffer.byteLength(JSON.stringify(base)+'\n'),referenceCount=0;
 const reasons=['current','previous','pending','blocked','operation_history',...projectedBackups.map(id=>'backup:'+id)];
 const candidateLength=Math.max(64,...rows.operations.map(op=>op.candidate_id?.length??0));
 const imageLength=Math.max(71,...rows.operations.map(op=>op.image_id?.length??0));
 const operationIdLength=Math.max(16,...rows.operations.map(op=>op.id.length));
 const artifactIdLength=Math.max(16,...rows.operations.map(op=>op.artifact_id.length));
 const projectedCount=rows.operations.length+additionalOperations;
 const mappingHeader={format:1,phase:'complete',installationId,sourceRecord:'x'.repeat(32),bundleHash:'x'.repeat(64),mapping:[]};
 let mappingBytes=Buffer.byteLength(JSON.stringify(mappingHeader)+'\n'),mappingCount=0;
 for(let index=0;index<projectedCount;index++){
  const existing=rows.operations[index];
  const reference={
   resource:'x'.repeat(imageLength),
   operationId:existing?.id??('cmv_'+'x'.repeat(Math.max(0,operationIdLength-4))),
   containerId:'x'.repeat(candidateLength),
   artifactId:existing?.artifact_id??('car_'+'x'.repeat(Math.max(0,artifactIdLength-4))),
   reasons,
  };
  inventoryBytes+=Buffer.byteLength(JSON.stringify(reference))+(referenceCount?1:0);referenceCount++;
  const mapping={
   operationId:existing?.id??('cmv_'+'x'.repeat(Math.max(0,operationIdLength-4))),
   sourceImageId:'x'.repeat(imageLength),
   imageId:'x'.repeat(imageLength),
   sourceContainerId:'x'.repeat(candidateLength),
   containerId:'x'.repeat(candidateLength),
  };
  mappingBytes+=Buffer.byteLength(JSON.stringify(mapping))+(mappingCount?1:0);mappingCount++;
  if(inventoryBytes>OPERATION_INVENTORY_MAX_BYTES)throw new Error('retention_inventory_size_limit');
  if(mappingBytes>OPERATION_INVENTORY_MAX_BYTES)throw new Error('operation_mapping_size_limit');
 }
}

export async function assertRetentionInventoryBudget(tx:DbOrTx,installationId:string,reservation:Reservation={}):Promise<void>{
 const rows=await readInventoryRows(tx,installationId);
 assertProjectedInventorySize(rows,installationId,new Date().toISOString(),reservation);
}

function limitFailure(error:unknown):boolean{
 return error instanceof Error&&[
  'retention_inventory_size_limit',
  'retention_inventory_operation_limit',
  'retention_inventory_backup_limit',
  'operation_mapping_size_limit',
 ].includes(error.message);
}

export async function retentionInventory(db:Db,installationId:string){
 try{
  return await db.transaction(async tx=>{
   const rows=await readInventoryRows(tx,installationId),observedAt=new Date().toISOString();
   assertProjectedInventorySize(rows,installationId,observedAt);
   const inventory=inventoryValue(rows,installationId,observedAt);
   assertOperationInventorySize(inventory);
   return inventory;
  });
 }catch(error){
  if(!limitFailure(error))throw error;
  return {format:1,mode:'preserve_all',installationId,observedAt:new Date().toISOString(),references:[],backups:[]};
 }
}
