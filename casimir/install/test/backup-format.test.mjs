import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {join} from 'node:path';import {tmpdir} from 'node:os';
const api=await import('../../../platform/packages/api/src/casimir/lifecycle/backup-format.ts').catch(()=>({}));
test('authenticated_backup_roundtrip_and_wrong_key_or_corruption_publish_nothing',async t=>{
 assert.equal(typeof api.writeEncryptedBackup,'function');const root=await mkdtemp(join(tmpdir(),'c1-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const src=join(root,'src');await mkdir(src,{mode:0o700});await writeFile(join(src,'control.sql'),'synthetic pg dump');await writeFile(join(src,'app.sqlite'),randomBytes(1024*1024));await writeFile(join(root,'key'),randomBytes(32),{mode:0o600});await writeFile(join(root,'wrong-key'),randomBytes(32),{mode:0o600});
 const meta={format:1,installationId:'a'.repeat(32),bundleVersion:'c1.0',references:['control.sql','app.sqlite']};
 const archive=join(root,'backup.enc');await api.writeEncryptedBackup(src,archive,join(root,'key'),meta);
 assert.ok(!(await readFile(archive)).includes(Buffer.from('synthetic pg dump')));
 const archiveSize=(await stat(archive)).size,mismatch=join(root,'size-mismatch'),beforeMismatch=(await readdir(root)).sort();
 await assert.rejects(()=>api.readEncryptedBackup(archive,join(root,'key'),mismatch,{expectedInputBytes:archiveSize-1}),/backup_size/);
 assert.deepEqual((await readdir(root)).sort(),beforeMismatch);await assert.rejects(()=>stat(mismatch),{code:'ENOENT'});
 const dest=join(root,'restore');await api.readEncryptedBackup(archive,join(root,'key'),dest,{expectedInputBytes:archiveSize});assert.deepEqual(await readFile(join(dest,'files/app.sqlite')),await readFile(join(src,'app.sqlite')));
 await assert.rejects(()=>api.readEncryptedBackup(archive,join(root,'wrong-key'),join(root,'bad')));await assert.rejects(()=>stat(join(root,'bad')),{code:'ENOENT'});
 const bytes=await readFile(archive);bytes[40]^=1;await writeFile(archive,bytes);await assert.rejects(()=>api.readEncryptedBackup(archive,join(root,'key'),join(root,'corrupt')));await assert.rejects(()=>stat(join(root,'corrupt')),{code:'ENOENT'});
});
test('incomplete_references_and_existing_output_are_refused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'c1-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'src'));await writeFile(join(root,'src/control.sql'),'dump');await writeFile(join(root,'key'),randomBytes(32),{mode:0o600});
 await assert.rejects(()=>api.writeEncryptedBackup(join(root,'src'),join(root,'out'),join(root,'key'),{format:1,installationId:'a'.repeat(32),bundleVersion:'c1.0',references:['missing.sqlite']}),/reference/);
});
