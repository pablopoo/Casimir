import type {BundleManifest} from './types.ts';
/** The sole supported platform pair preserves the app/SDK/database runtime. */
export function assertUpgradePair(source:BundleManifest,target:BundleManifest):void{
 if(source.version!=='c1.0'||target.version!=='c1.1'||!target.upgradeFrom.includes(source.version))throw new Error('unsupported_upgrade_pair');
 if(source.platform!==target.platform||JSON.stringify(source.runtime)!==JSON.stringify(target.runtime))throw new Error('upgrade_runtime_change_refused');
 const sdk=(bundle:BundleManifest)=>JSON.stringify([...bundle.sdk].sort((a,b)=>a.path.localeCompare(b.path)));
 if(sdk(source)!==sdk(target))throw new Error('upgrade_sdk_change_refused');
 const image=(bundle:BundleManifest,role:string)=>{const found=bundle.images.find(i=>i.role===role);if(!found)throw new Error('upgrade_image_missing');return found.imageId;};
 for(const role of ['runner','database','ingress'])if(image(source,role)!==image(target,role))throw new Error('upgrade_dependency_change_refused');
 if(source.sourceRevision===target.sourceRevision||image(source,'control')===image(target,'control'))throw new Error('upgrade_requires_distinct_release');
 if(source.controlSchema.version!==1||target.controlSchema.version!==2||source.controlSchema.migrationHashes.length!==1||target.controlSchema.migrationHashes.length!==2||source.controlSchema.migrationHashes[0]!==target.controlSchema.migrationHashes[0]||!target.controlSchema.readableBy.includes(target.version))throw new Error('upgrade_schema_pair_refused');
}

import {sql} from 'drizzle-orm';import type {Db} from '../../db/client.ts';import {assertControlSchema,controlMigrationCatalog} from './control-migrations.ts';
export type UpgradeIntent={format:1;id:string;installationId:string;source:BundleManifest;target:BundleManifest;sourceHash:string;targetHash:string;backupRecordId:string;backupHash:string};
export async function applyControlUpgrade(db:Db,intent:UpgradeIntent,assertLive:()=>void){
 assertUpgradePair(intent.source,intent.target);
 if(intent.format!==1||![intent.id,intent.installationId,intent.backupRecordId].every(v=>/^[a-f0-9]{32}$/.test(v))||![intent.sourceHash,intent.targetHash,intent.backupHash].every(v=>/^[a-f0-9]{64}$/.test(v)))throw new Error('upgrade_intent_invalid');
 const catalog=await controlMigrationCatalog(intent.target.version);if(JSON.stringify(catalog.map(m=>m.hash))!==JSON.stringify(intent.target.controlSchema.migrationHashes))throw new Error('upgrade_migration_hash');
 assertLive();return db.transaction(async tx=>{
  const installation=(await tx.execute<{installation_id:string;phase:string;bundle_version:string}>(sql`SELECT installation_id,phase,bundle_version FROM casimir_install.installation WHERE id=1 FOR UPDATE`)).rows[0];
  if(installation?.installation_id!==intent.installationId||installation.phase!=='maintenance')throw new Error('upgrade_requires_verified_maintenance');
  await tx.execute(sql`SELECT id FROM casimir_mvp_a.scope WHERE id=1 FOR UPDATE`);assertLive();
  const existing=(await tx.execute<{phase:string;source_version:string;target_version:string;inventory_hash:string;detail:{sourceHash:string;targetHash:string;backupRecordId:string}}>(sql`SELECT phase,source_version,target_version,inventory_hash,detail FROM casimir_install.maintenance WHERE id=${intent.id} AND installation_id=${intent.installationId} AND kind='upgrade' FOR UPDATE`)).rows[0];
  if(existing){
   if(existing.source_version!==intent.source.version||existing.target_version!==intent.target.version||existing.inventory_hash!==intent.backupHash||existing.detail.sourceHash!==intent.sourceHash||existing.detail.targetHash!==intent.targetHash||existing.detail.backupRecordId!==intent.backupRecordId)throw new Error('upgrade_intent_conflict');
   if(!['migrated','compatibility_verified','exposure_started'].includes(existing.phase)||installation.bundle_version!==intent.target.version)throw new Error('upgrade_phase_conflict');
   await assertControlSchema(tx,intent.target.version);return {id:intent.id,phase:existing.phase};
  }
  if(installation.bundle_version!==intent.source.version)throw new Error('upgrade_source_version');
  const backup=(await tx.execute<{kind:string;phase:string;source_version:string;inventory_hash:string}>(sql`SELECT kind,phase,source_version,inventory_hash FROM casimir_install.maintenance WHERE id=${intent.backupRecordId} AND installation_id=${intent.installationId} FOR UPDATE`)).rows[0];
  if(!backup||backup.kind!=='backup'||backup.phase!=='verified'||backup.source_version!==intent.source.version||backup.inventory_hash!==intent.backupHash)throw new Error('upgrade_requires_verified_maintenance');
  const other=await tx.execute(sql`SELECT id FROM casimir_install.maintenance WHERE installation_id=${intent.installationId} AND phase<>'complete' AND id<>${intent.backupRecordId} LIMIT 1`);if(other.rows.length)throw new Error('upgrade_maintenance_conflict');
  if((await tx.execute(sql`SELECT id FROM casimir_mvp_a.operations WHERE phase NOT IN ('succeeded','failed') LIMIT 1`)).rows.length)throw new Error('upgrade_unresolved_operation');
  await assertControlSchema(tx,intent.source.version);
  const detail={sourceHash:intent.sourceHash,targetHash:intent.targetHash,backupRecordId:intent.backupRecordId,migrationHashes:intent.target.controlSchema.migrationHashes};
  await tx.execute(sql`INSERT INTO casimir_install.maintenance(id,installation_id,kind,phase,source_version,target_version,inventory_hash,detail) VALUES(${intent.id},${intent.installationId},'upgrade','prepared',${intent.source.version},${intent.target.version},${intent.backupHash},${JSON.stringify(detail)}::jsonb)`);
  assertLive();await tx.execute(sql.raw(catalog[1].source));await tx.execute(sql`INSERT INTO casimir_install.schema_migrations(version,hash) VALUES(2,${catalog[1].hash})`);
  await tx.execute(sql`UPDATE casimir_install.installation SET bundle_version=${intent.target.version},updated_at=now() WHERE id=1`);
  await tx.execute(sql`UPDATE casimir_install.maintenance SET phase='migrated',updated_at=now() WHERE id=${intent.id}`);
  return {id:intent.id,phase:'migrated'};
 });
}
