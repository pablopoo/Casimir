import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertUpgradePair} from '../../../platform/packages/api/src/casimir/lifecycle/upgrade.ts';
const source=()=>({version:'c1.0',sourceRevision:'a'.repeat(40),platform:'linux/amd64',runtime:{runtimeId:'r',sdkVersion:'1.1.11'},sdk:[{path:'sdk/void.tgz',sha256:'s'}],images:['control','runner','database','ingress'].map(role=>({role,imageId:role+'-old'})),controlSchema:{version:1,migrationHashes:['hash1'],readableBy:['c1.0']},upgradeFrom:[]});
const target=()=>{const t=source();t.version='c1.1';t.sourceRevision='b'.repeat(40);t.images[0].imageId='control-new';t.controlSchema={version:2,migrationHashes:['hash1','hash2'],readableBy:['c1.1']};t.upgradeFrom=['c1.0'];return t;};
test('upgrade_pair_requires_distinct_revision_image_and_forward_schema',()=>{
 assert.doesNotThrow(()=>assertUpgradePair(source(),target()));
 for(const change of [t=>t.sourceRevision=source().sourceRevision,t=>t.images[0].imageId='control-old',t=>t.controlSchema.migrationHashes[0]='changed',t=>t.controlSchema.version=1,t=>t.upgradeFrom=[]]){const t=target();change(t);assert.throws(()=>assertUpgradePair(source(),t));}
});
test('unknown_downgrade_and_runtime_driver_sdk_changes_are_refused',()=>{
 assert.throws(()=>assertUpgradePair(target(),source()));
 for(const change of [t=>t.version='c1.2',t=>t.runtime.runtimeId='other',t=>t.images[1].imageId='different-runner',t=>t.images[2].imageId='different-pg',t=>t.sdk[0].sha256='different-sdk']){const t=target();change(t);assert.throws(()=>assertUpgradePair(source(),t));}
});
