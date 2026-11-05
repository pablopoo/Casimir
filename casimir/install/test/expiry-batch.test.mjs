import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const require=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url)),{Pool}=require('pg'),{sql}=require('drizzle-orm');
test('expiry_batches_100_and_rechecks_referenced_sealed_payload_without_deleting_rows',async()=>{
 assert.equal(typeof checks.expireMvpUploadBatch,'function');
 const pool=new Pool({connectionString:(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length)}),root=await mkdtemp(join(tmpdir(),'expiry-')),rollback=new Error('rollback');
 try{await mkdir(join(root,'sealed'));await mkdir(join(root,'staging'));const first='upl_c10000000001',last='upl_c10000000101';await writeFile(join(root,'sealed',first+'.gz'),'orphan');await writeFile(join(root,'sealed',last+'.gz'),'referenced');let guarded=0;
 await assert.rejects(()=>checks.createDb(pool).transaction(async tx=>{
  await tx.execute(sql`UPDATE casimir_mvp_a.uploads SET expires_at=now()+interval '1 day'`);
  await tx.execute(sql`INSERT INTO casimir_mvp_a.uploads(id,project_id,actor_id,bytes,sha256,expires_at) SELECT 'upl_c1'||lpad(n::text,10,'0'),project_id,operator_id,1,repeat('a',64),now()-interval '1 day' FROM casimir_install.installation CROSS JOIN generate_series(1,101) n WHERE casimir_install.installation.id=1`);
  await tx.execute(sql`INSERT INTO casimir_mvp_a.artifacts(id,upload_id,project_id,actor_id,path,bytes,sha256,manifest,runtime) SELECT 'car_c10000000101',id,project_id,actor_id,'sealed/'||id||'.gz',bytes,sha256,'{}','{}' FROM casimir_mvp_a.uploads WHERE id=${last}`);
  const db={transaction:fn=>fn(tx)},profile={artifactRoot:root};const a=await checks.expireMvpUploadBatch(db,profile,'',()=>guarded++);assert.equal(a.count,100);const b=await checks.expireMvpUploadBatch(db,profile,a.cursor,()=>guarded++);assert.equal(b.count,1);const c=await checks.expireMvpUploadBatch(db,profile,b.cursor,()=>guarded++);assert.equal(c.count,0);assert.equal(c.cursor,'');await assert.rejects(stat(join(root,'sealed',first+'.gz')),{code:'ENOENT'});assert.equal(await readFile(join(root,'sealed',last+'.gz'),'utf8'),'referenced');assert.ok(guarded>=101);throw rollback;
 }),e=>e===rollback);
 }finally{await pool.end();await rm(root,{recursive:true,force:true});}
});
