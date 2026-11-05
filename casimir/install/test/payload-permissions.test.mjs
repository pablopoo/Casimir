import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';import {join} from 'node:path';
test('public_bundle_is_traversable_and_archives_readable_across_operator_uids',async t=>{
 const {publishPayloadPermissions}=await import('../payload-permissions.mjs');const root=await mkdtemp('/tmp/c1-permissions-');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'images'),{mode:0o700});await writeFile(join(root,'images/lifecycle.tar'),'image',{mode:0o600});await writeFile(join(root,'casimir'),'wrapper',{mode:0o600});
 await publishPayloadPermissions(root);assert.equal((await stat(root)).mode&0o777,0o755);assert.equal((await stat(join(root,'images'))).mode&0o777,0o755);assert.equal((await stat(join(root,'images/lifecycle.tar'))).mode&0o777,0o644);assert.equal((await stat(join(root,'casimir'))).mode&0o777,0o755);
});
