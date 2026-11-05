import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const req=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url)),{Pool}=req('pg'),{sql}=req('drizzle-orm');
const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length),pool=new Pool({connectionString});
test('stop_persists_admission_gate_before_draining_existing_operation',async t=>{
 t.after(()=>pool.end());const db=checks.createDb(pool),rollback=new Error('fixture_rollback');
 await assert.rejects(()=>db.transaction(async tx=>{
  // All fixture changes roll back; retained recovery state is unchanged.
  await tx.execute(sql`UPDATE casimir_install.installation SET phase='ready' WHERE id=1`);
  const {operator_id:user,project_id:project}= (await tx.execute(sql`SELECT * FROM casimir_install.installation WHERE id=1`)).rows[0];
  await tx.execute(sql`INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256) VALUES('stop-upload',${project},${user},1,${'a'.repeat(64)})`);
  await tx.execute(sql`INSERT INTO casimir_mvp_a.artifacts(id,upload_id,project_id,actor_id,path,bytes,sha256,manifest,runtime) VALUES('stop-artifact','stop-upload',${project},${user},'/fixture',1,${'a'.repeat(64)},'{}','{}')`);
  await tx.execute(sql`INSERT INTO deployments(id,project_id) VALUES('stop-deployment',${project})`);
  await tx.execute(sql`INSERT INTO casimir_mvp_a.operations(id,project_id,actor_id,artifact_id,deployment_id,idempotency_key,input_hash,runtime) VALUES('stop-operation',${project},${user},'stop-artifact','stop-deployment','stop-key','fixture','{}')`);
  await assert.rejects(()=>checks.beginInstallationMaintenance(tx,'1'.repeat(32),'backup','c1.0'),/unresolved/);
  const record=await checks.beginInstallationMaintenance(tx,'1'.repeat(32),'stop','c1.0');assert.equal(record.phase,'requested');
  await assert.rejects(()=>checks.assertInstallationAdmission(tx,'1'.repeat(32)),/maintenance/);
  assert.equal((await tx.execute(sql`SELECT phase FROM casimir_mvp_a.operations WHERE id='stop-operation'`)).rows[0].phase,'queued');
  throw rollback;
 }),e=>e===rollback);
 assert.equal((await pool.query('SELECT phase FROM casimir_install.installation WHERE id=1')).rows[0].phase,'recovery_required');
});
