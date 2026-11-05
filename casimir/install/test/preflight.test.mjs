import {test} from 'node:test';import assert from 'node:assert/strict';
const api=await import('../preflight.mjs').catch(()=>({}));
test('version_parser_accepts_documented_prefix_and_rejects_unqualified_or_malformed',()=>{
 assert.equal(typeof api.qualifyVersions,'function');assert.equal(api.qualifyVersions('29.9.1','Docker Compose version v5.6.0'),true);
 for(const [engine,compose] of [['29.10.1','5.6.0'],['29.9','5.6.0'],['junk29.9.1','5.6.0'],['29.9.1','5.6.0-extra'],['29.9.1','5.7.0']])assert.throws(()=>api.qualifyVersions(engine,compose),/version/);
});
test('restore_disk_forecast_bounds_archive_and_accounts_for_plaintext_and_extraction_peak',()=>{
 assert.equal(typeof api.restoreDiskRequirement,'function');
 assert.equal(typeof api.qualifyRestoreDiskCapacity,'function');
 const bundleBytes=2*1024**3, backupBytes=16*1024**3+4*1024**2+100;
 const required=api.restoreDiskRequirement(bundleBytes,backupBytes);
 const backupPeak=2n*BigInt(backupBytes);
 const imageLoadPeak=3n*BigInt(bundleBytes);
 const floor=20n*(1024n**3n);
 assert.equal(required,backupPeak+imageLoadPeak+floor);
 assert.equal(api.qualifyRestoreDiskCapacity(required-1n,bundleBytes,backupBytes).ok,false);
 assert.equal(api.qualifyRestoreDiskCapacity(required,bundleBytes,backupBytes).ok,true);
 const smallBundleBytes=1024**3, transient=2n*BigInt(backupBytes)+3n*BigInt(smallBundleBytes);
 assert.equal(api.restoreDiskRequirement(smallBundleBytes,backupBytes),20n*(1024n**3n)+transient);
 assert.equal(api.qualifyRestoreDiskCapacity(20n*(1024n**3n)+transient-1n,smallBundleBytes,backupBytes).ok,false);
 assert.equal(api.qualifyRestoreDiskCapacity(20n*(1024n**3n)+transient,smallBundleBytes,backupBytes).ok,true);
 assert.throws(()=>api.restoreDiskRequirement(bundleBytes,backupBytes+1),/backup_size/);
 assert.equal(api.restoreDiskRequirement(0,0),20n*(1024n**3n));
});
