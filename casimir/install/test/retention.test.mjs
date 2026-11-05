import {test} from 'node:test';import assert from 'node:assert/strict';import * as api from '../../../platform/packages/api/src/casimir/lifecycle/retention.ts';
import {assertOperationInventorySize} from '../../../platform/packages/api/src/casimir/lifecycle/retention-inventory.ts';
import {OPERATION_INVENTORY_MAX_BYTES} from '../../../platform/packages/api/src/casimir/lifecycle/identity.ts';
test('retention_pins_current_previous_pending_blocked_backup_and_keeps_history',()=>{
 assert.equal(typeof api.retentionReferences,'function');
 const prior={id:'prior',deployment_id:'d0',phase:'succeeded',image_id:'prior-image'},current={id:'current',deployment_id:'d1',phase:'succeeded',image_id:'current-image',previous_target:{previousOperationId:'prior',route:{deploymentId:'d0'}}};
 const records=api.retentionReferences(current,[prior,current,{id:'pending',deployment_id:'d2',phase:'preparing',image_id:'pending-image'},{id:'blocked',deployment_id:'d3',phase:'recovery_required',image_id:'blocked-image'},{id:'saved',deployment_id:'d4',phase:'failed',image_id:'backup-image'},{id:'history',deployment_id:'d5',phase:'failed',image_id:'history-image'}],[{id:'backup-record',operations:['saved']}]);
 for(const [resource,reason]of [['current-image','current'],['prior-image','previous'],['pending-image','pending'],['blocked-image','blocked'],['backup-image','backup:backup-record'],['history-image','operation_history']])assert.ok(records.find(r=>r.resource===resource).reasons.includes(reason));
});
test('operation_inventory_supports_history_above_small_private_state_limit_and_enforces_exact_cap',()=>{
 const base={format:1,installationId:'a'.repeat(32),observedAt:'2026-10-19T00:00:00.000Z',references:[],backups:[]};
 const references=Array.from({length:1200},(_,i)=>({resource:'sha256:'+i.toString(16).padStart(64,'0'),operationId:`cmv_${i.toString(36).padStart(12,'0')}`,containerId:'a'.repeat(64),artifactId:`car_${i.toString(36).padStart(12,'0')}`,reasons:['operation_history']}));
 const large={...base,references};assert.ok(Buffer.byteLength(JSON.stringify(large)+'\n')>65536);assert.ok(assertOperationInventorySize(large)>65536);
 const example={...base,references:[{resource:'',operationId:'cmv_000000000000',containerId:null,artifactId:'car_000000000000',reasons:['operation_history']}]};
 const fixed=Buffer.byteLength(JSON.stringify(example)+'\n');
 example.references[0].resource='x'.repeat(OPERATION_INVENTORY_MAX_BYTES-fixed);
 assert.equal(assertOperationInventorySize(example),OPERATION_INVENTORY_MAX_BYTES);
 example.references[0].resource+='x';assert.throws(()=>assertOperationInventorySize(example),/retention_inventory_size_limit/);
});
