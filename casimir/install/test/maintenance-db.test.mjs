import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const req=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url)),{Pool}=req('pg'),{sql}=req('drizzle-orm');
const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length);const pool=new Pool({connectionString});
test('persistent_maintenance_excludes_admission_and_unknown_state_fails_closed',async t=>{
 t.after(()=>pool.end());const db=checks.createDb(pool),rollback=new Error('fixture_rollback');
 await assert.rejects(()=>db.transaction(async tx=>{
  // A transaction-local ready fixture keeps the deliberately retained blocked
  // installation unchanged and makes repeat runs independent of earlier tests.
  await tx.execute(sql`UPDATE casimir_install.installation SET phase='ready' WHERE id=1`);
  const record=await checks.beginInstallationMaintenance(tx,'1'.repeat(32),'backup','c1.0');assert.equal(record.kind,'backup');
  await assert.rejects(()=>checks.assertInstallationAdmission(tx,'1'.repeat(32)),/maintenance/);
  assert.equal((await checks.beginInstallationMaintenance(tx,'1'.repeat(32),'backup','c1.0')).id,record.id);
  await assert.rejects(()=>checks.beginInstallationMaintenance(tx,'1'.repeat(32),'upgrade','c1.0'),/maintenance/);
  await tx.execute(sql`UPDATE casimir_install.installation SET phase='recovery_required' WHERE id=1`);
  await assert.rejects(()=>checks.beginInstallationMaintenance(tx,'1'.repeat(32),'backup','c1.0'),/recovery/);
  throw rollback;
 }),error=>error===rollback);
 assert.equal((await pool.query('SELECT phase FROM casimir_install.installation WHERE id=1')).rows[0].phase,'recovery_required');
});
