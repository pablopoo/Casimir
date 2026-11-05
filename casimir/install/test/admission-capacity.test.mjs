import {test} from 'node:test';import assert from 'node:assert/strict';import * as checks from '../../dist/checks.mjs';
test('installation_admission_refuses_actual_small_tmpfs_without_deleting_data',async()=>{
 assert.equal(typeof checks.assertAdmissionCapacity,'function');
 await assert.rejects(()=>checks.assertAdmissionCapacity({installationId:'1'.repeat(32),artifactRoot:'/dev/shm'},1),e=>e.message==='installation_disk_reserve');
 await checks.assertAdmissionCapacity({artifactRoot:'/dev/shm'},1);
});
