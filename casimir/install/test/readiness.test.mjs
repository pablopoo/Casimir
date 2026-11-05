import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import * as checks from '../../dist/checks.mjs';
const {Pool}=createRequire(new URL('../../../platform/packages/api/package.json',import.meta.url))('pg');
const connectionString=(await readFile('.local/c1/test.env','utf8')).trim().slice('DATABASE_URL='.length);const pool=new Pool({connectionString});
test('readiness_never_turns_persisted_recovery_into_ready',async t=>{
 t.after(()=>pool.end());assert.equal(typeof checks.inspectInstallationReadiness,'function');
 const result=await checks.inspectInstallationReadiness({db:checks.createDb(pool),profile:{installationId:'1'.repeat(32)},engine:{async verifyEnvironment(){assert.fail('blocked readiness probed runtime');}}});
 assert.equal(result.outcome,'blocked');assert.equal(result.code,'recovery_required');assert.equal(result.servingObservation,undefined);
});
