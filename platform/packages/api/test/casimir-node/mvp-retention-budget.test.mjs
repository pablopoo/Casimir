import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as checks from '../../../../../casimir/dist/checks.mjs';
import { withMvpControl, artifact, runtime } from './mvp-support.mjs';

const installationId='2'.repeat(32);

async function project(t){
 const response=await t.request('/projects',{slug:'retention-budget'});
 assert.equal(response.status,201,JSON.stringify(response.body));
 await t.db.query('CREATE SCHEMA casimir_install');
 await t.db.query(`CREATE TABLE casimir_install.installation(
  id integer PRIMARY KEY CHECK(id=1),installation_id text NOT NULL,operator_id text NOT NULL,
  project_id text NOT NULL,bundle_version text NOT NULL,phase text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
 await t.db.query(`CREATE TABLE casimir_install.maintenance(
  id text PRIMARY KEY,installation_id text NOT NULL,kind text NOT NULL,phase text NOT NULL,
  source_version text NOT NULL,target_version text,inventory_hash text,last_error_code text,
  detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
 await t.db.query(`INSERT INTO casimir_install.installation(id,installation_id,operator_id,project_id,bundle_version,phase)
  VALUES(1,$1,'casimir_test_operator',$2,'c1.0','ready')`,[installationId,response.body.id]);
 return response.body.id;
}

async function seedOperations(db,projectId,count){
 await db.query(`INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256)
  SELECT 'upl_'||lpad(n::text,12,'0'),$1,'casimir_test_operator',1,repeat('a',64) FROM generate_series(1,$2) n`,[projectId,count]);
 await db.query(`INSERT INTO casimir_mvp_a.artifacts(id,upload_id,project_id,actor_id,path,bytes,sha256,manifest,runtime)
  SELECT 'car_'||lpad(n::text,12,'0'),'upl_'||lpad(n::text,12,'0'),$1,'casimir_test_operator',
   'sealed/upl_'||lpad(n::text,12,'0')||'.gz',1,repeat('a',64),'{}','{}' FROM generate_series(1,$2) n`,[projectId,count]);
 await db.query(`INSERT INTO deployments(id,project_id)
  SELECT 'dpl_'||lpad(n::text,12,'0'),$1 FROM generate_series(1,$2) n`,[projectId,count]);
 await db.query(`INSERT INTO casimir_mvp_a.operations(id,project_id,actor_id,artifact_id,deployment_id,idempotency_key,input_hash,runtime,phase,image_id,candidate_id)
  SELECT 'cmv_'||lpad(n::text,12,'0'),$1,'casimir_test_operator','car_'||lpad(n::text,12,'0'),
   'dpl_'||lpad(n::text,12,'0'),'history-'||n,repeat('b',64),'{}','succeeded','sha256:'||repeat('c',64),repeat('d',64)
  FROM generate_series(1,$2) n`,[projectId,count]);
 return 'cmv_'+String(1).padStart(12,'0');
}

test('deployment admission reserves one operation and restore-mapping row before the cap',async()=>{
 await withMvpControl(async t=>{
  const projectId=await project(t);
  await seedOperations(t.db,projectId,2047);
  const value=artifact(),uploadId='upl_zzzzzzzzzzzz',artifactId='car_zzzzzzzzzzzz';
  await t.db.query(`INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256,state)
   VALUES($1,$2,'casimir_test_operator',$3,$4,'finalized')`,[uploadId,projectId,value.bytes.length,value.sha256]);
  await t.db.query(`INSERT INTO casimir_mvp_a.artifacts(id,upload_id,project_id,actor_id,path,bytes,sha256,manifest,runtime)
   VALUES($1,$2,$3,'casimir_test_operator',$4,$5,$6,$7::jsonb,$8::jsonb)`,[
   artifactId,uploadId,projectId,'sealed/'+uploadId+'.gz',value.bytes.length,value.sha256,JSON.stringify(value.manifest),JSON.stringify(runtime),
  ]);

  const admitted=await checks.admitArtifactDeployment(
   checks.createDb(t.db),'casimir_test_operator',projectId,artifactId,'boundary-admitted',runtime,installationId,
  );
  assert.ok(admitted.operationId);
  await t.db.query(`UPDATE casimir_mvp_a.operations SET phase='succeeded',image_id=$2,candidate_id=$3 WHERE id=$1`,[
   admitted.operationId,'sha256:'+'e'.repeat(64),'f'.repeat(64),
  ]);
  const inventory=await checks.retentionInventory(checks.createDb(t.db),installationId);
  assert.equal(inventory.mode,undefined);
  assert.ok(checks.assertOperationInventorySize(inventory)>65536);
  const mapping=Array.from({length:2048},(_,i)=>({
   operationId:`cmv_${i.toString().padStart(12,'0')}`,sourceImageId:'sha256:'+'a'.repeat(64),
   imageId:'sha256:'+'b'.repeat(64),sourceContainerId:'c'.repeat(64),containerId:'d'.repeat(64),
  }));
  assert.ok(checks.assertOperationMappingSize({format:1,phase:'complete',installationId,sourceRecord:'1'.repeat(32),bundleHash:'2'.repeat(64),mapping})>65536);
  await assert.rejects(
   ()=>checks.admitArtifactDeployment(checks.createDb(t.db),'casimir_test_operator',projectId,artifactId,'boundary-refused',runtime,installationId),
   /retention_inventory_operation_limit|operation_mapping_size_limit/,
  );
  assert.equal((await t.db.query('SELECT count(*)::int AS count FROM casimir_mvp_a.operations')).rows[0].count,2048);
 },{installationId});
});

test('backup admission reserves its backup row and reasons; stop and inventory remain available at the boundary',async()=>{
 await withMvpControl(async t=>{
  const projectId=await project(t),operationId=await seedOperations(t.db,projectId,1);
  await t.db.query(`UPDATE projects SET active_deployment_id='dpl_'||lpad('1',12,'0') WHERE id=$1`,[projectId]);
  await t.db.query(`INSERT INTO casimir_install.maintenance(id,installation_id,kind,phase,source_version,inventory_hash,detail)
   SELECT md5('seed-backup-'||n),$1,'backup','complete','c1.0',repeat('a',64),
    jsonb_build_object('operations',jsonb_build_array(jsonb_build_object('id',$2::text)))
   FROM generate_series(1,255) n`,[installationId,operationId]);

  const admitted=await checks.beginInstallationMaintenance(checks.createDb(t.db),installationId,'backup','c1.0');
  assert.equal(admitted.phase,'requested');
  await t.db.query(`UPDATE casimir_install.maintenance SET phase='verified',inventory_hash=repeat('b',64),
   detail=jsonb_build_object('operations',jsonb_build_array(jsonb_build_object('id',$2::text))) WHERE id=$1`,[admitted.id,operationId]);
  await t.db.query("UPDATE casimir_install.installation SET phase='ready' WHERE id=1");
  const inventory=await checks.retentionInventory(checks.createDb(t.db),installationId);
  assert.equal(inventory.backups.length,256);
  assert.ok(inventory.references[0].reasons.some(reason=>reason==='backup:'+admitted.id));
  assert.ok(checks.assertOperationInventorySize(inventory)<=768*1024);

  const stop=await checks.beginInstallationMaintenance(checks.createDb(t.db),installationId,'stop','c1.0');
  assert.equal(stop.phase,'requested');
  await t.db.query("UPDATE casimir_install.maintenance SET phase='complete' WHERE id=$1",[stop.id]);
  await t.db.query("UPDATE casimir_install.installation SET phase='ready' WHERE id=1");
  await assert.rejects(
   ()=>checks.beginInstallationMaintenance(checks.createDb(t.db),installationId,'backup','c1.0'),
   /retention_inventory_backup_limit/,
  );
  assert.equal((await t.db.query('SELECT phase FROM casimir_install.installation WHERE id=1')).rows[0].phase,'ready');
  assert.equal((await t.db.query('SELECT count(*)::int AS count FROM casimir_install.maintenance WHERE kind=\'backup\'')).rows[0].count,256);
 },{installationId});
});

test('oversized legacy backup references fail closed to preserve-all without returning unbounded ids',async()=>{
 await withMvpControl(async t=>{
  const projectId=await project(t),largeId='x'.repeat(128*1024);
  await t.db.query(`INSERT INTO casimir_install.maintenance(id,installation_id,kind,phase,source_version,inventory_hash,detail)
   VALUES(md5('oversized-backup'),$1,'backup','verified','c1.0',repeat('a',64),$2::jsonb)`,[
   installationId,JSON.stringify({operations:[{id:largeId}]}),
  ]);
  const inventory=await checks.retentionInventory(checks.createDb(t.db),installationId);
  assert.equal(inventory.mode,'preserve_all');
  assert.deepEqual(inventory.references,[]);
  await assert.rejects(
   ()=>checks.assertRetentionInventoryBudget(checks.createDb(t.db),installationId,{additionalOperations:1}),
   /retention_inventory_size_limit/,
  );
 },{installationId});
});
