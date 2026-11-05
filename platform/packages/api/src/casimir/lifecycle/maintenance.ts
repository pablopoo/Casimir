import {randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Db,DbOrTx} from '../../db/client.ts';
import {LocalHttpError} from '../project-service.ts';
import {deriveResources} from './resources.ts';
import type {MaintenanceRecord} from './types.ts';
import {assertRetentionInventoryBudget} from './retention-inventory.ts';
export async function assertInstallationAdmission(tx: DbOrTx, installationId: string): Promise<void> {
 deriveResources(installationId);
 const rows=await tx.execute<{installation_id:string;phase:string}>(sql`SELECT installation_id,phase FROM casimir_install.installation WHERE id=1 FOR UPDATE`);
 if(rows.rows[0]?.installation_id!==installationId || rows.rows[0].phase!=='ready')throw new LocalHttpError(409,'installation_maintenance_or_recovery_required');
}
export async function beginInstallationMaintenance(db: Db,installationId: string,kind: MaintenanceRecord['kind'],version: string): Promise<MaintenanceRecord>{
 deriveResources(installationId);if(!['backup','restore','upgrade','stop'].includes(kind))throw new Error('maintenance_kind');
 return db.transaction(async tx=>{
  const installation=await tx.execute<{installation_id:string;phase:string;bundle_version:string}>(sql`SELECT installation_id,phase,bundle_version FROM casimir_install.installation WHERE id=1 FOR UPDATE`);
  const row=installation.rows[0];if(!row||row.installation_id!==installationId||row.bundle_version!==version)throw new Error('maintenance_identity');
  if(row.phase==='recovery_required'||row.phase==='stopped')throw new Error('recovery_or_stopped_refused');
  if(row.phase==='maintenance'){
   const prior=await tx.execute<{id:string;kind:MaintenanceRecord['kind'];phase:string;source_version:string}>(sql`SELECT * FROM casimir_install.maintenance WHERE installation_id=${installationId} AND phase<>'complete' ORDER BY created_at DESC LIMIT 1`);
   const p=prior.rows[0];if(!p||p.kind!==kind)throw new Error('maintenance_conflict');return {id:p.id,installationId,kind,phase:p.phase,sourceVersion:p.source_version};
  }
  if(row.phase!=='ready')throw new Error('unknown_installation_phase');
  // Same scope lock as admission; commit the gate before any external action.
  await tx.execute(sql`SELECT id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`);
  if(kind==='backup')await assertRetentionInventoryBudget(tx,installationId,{additionalBackups:1});
  const unresolved=await tx.execute(sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`);
  if(unresolved.rows.length && kind!=='stop')throw new Error('unresolved_operation_refused');
  const id=randomBytes(16).toString('hex');
  await tx.execute(sql`INSERT INTO casimir_install.maintenance(id,installation_id,kind,phase,source_version) VALUES(${id},${installationId},${kind},'requested',${version})`);
  await tx.execute(sql`UPDATE casimir_install.installation SET phase='maintenance',updated_at=now() WHERE id=1`);
  return {id,installationId,kind,phase:'requested',sourceVersion:version};
 });
}
