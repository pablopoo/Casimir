import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const {Pool}=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url))('pg');
const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length);const pool=new Pool({connectionString});
test('quiesce_refuses_recovery_before_touching_writer_or_proxy',async t=>{
 t.after(()=>pool.end());assert.equal(typeof checks.quiesceInstallation,'function');
 await assert.rejects(()=>checks.quiesceInstallation({db:checks.createDb(pool),profile:{installationId:'1'.repeat(32)},guard:{assertLive(){}},engine:{async closeProxy(){assert.fail('blocked proxy mutated');}}},'backup'),/maintenance_required/);
});
