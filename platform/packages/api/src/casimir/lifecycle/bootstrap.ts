import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { createUser } from '../../db/users.ts';
import { createLocalProject } from '../project-service.ts';
import { deriveResources } from './resources.ts';
import {controlMigrationCatalog,assertControlSchema} from './control-migrations.ts';
export async function bootstrapInstallationDatabase(db: Db, installationId: string, bundleVersion: string): Promise<{operatorId: string;projectId: string}> {
 deriveResources(installationId);
 if(!/^c1\.[0-9]+$/.test(bundleVersion)) throw new Error('bundle_version_invalid');
 const catalog=await controlMigrationCatalog(bundleVersion);
 return db.transaction(async tx=>{
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1128354643,6)`);
  await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS casimir_install`);
  await tx.execute(sql`CREATE TABLE IF NOT EXISTS casimir_install.schema_migrations(version integer PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrations=await tx.execute<{version:number;hash:string}>(sql`SELECT version,hash FROM casimir_install.schema_migrations ORDER BY version`);
  if(!migrations.rows.length){for(const migration of catalog){await tx.execute(sql.raw(migration.source));await tx.execute(sql`INSERT INTO casimir_install.schema_migrations(version,hash) VALUES(${migration.version},${migration.hash})`);}}
  else await assertControlSchema(tx,bundleVersion);
  const existing=await tx.execute<{installation_id:string;operator_id:string;project_id:string;bundle_version:string}>(sql`SELECT * FROM casimir_install.installation WHERE id=1 FOR UPDATE`);
  if(existing.rows[0]) {
   const row=existing.rows[0];if(row.installation_id!==installationId || row.bundle_version!==bundleVersion) throw new Error('foreign_database_identity');
   return {operatorId:row.operator_id,projectId:row.project_id};
  }
  const occupied=await tx.execute(sql`SELECT id FROM users UNION ALL SELECT id FROM projects LIMIT 1`);
  if(occupied.rows.length) throw new Error('initialized_database_not_adopted');
  const operator=await createUser(tx,'casimir-local',installationId,'local-operator','operator@example.invalid','admin');
  const project=await createLocalProject(tx,operator.id,'casimir-reference');
  await tx.execute(sql`INSERT INTO casimir_install.installation(id,installation_id,operator_id,project_id,bundle_version,phase) VALUES(1,${installationId},${operator.id},${project.id},${bundleVersion},'ready')`);
  await tx.execute(sql`UPDATE casimir_mvp_a.scope SET project_id=${project.id} WHERE id=1`);
  return {operatorId:operator.id,projectId:project.id};
 });
}
