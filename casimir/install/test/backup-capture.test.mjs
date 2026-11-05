import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const {Pool}=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url))('pg');
test('backup_capture_refuses_recovery_before_native_job_or_file_access',async t=>{
 const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length);const pool=new Pool({connectionString});t.after(()=>pool.end());
 await assert.rejects(()=>checks.prepareBackupCapture({db:checks.createDb(pool),profile:{installationId:'1'.repeat(32)},guard:{assertLive(){}},engine:{async runJob(){assert.fail('native job before durable gate');}}}),/maintenance_required/);
});
