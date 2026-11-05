import {test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{execFileSync,spawnSync}from'node:child_process';import{createHash}from'node:crypto';
test('whole_archive_verification_and_safe_extraction_refuse_links_traversal_and_existing_destination',async t=>{
 const root=await mkdtemp(join(tmpdir(),'c1-extract-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source');await mkdir(source);await writeFile(join(source,'bundle.json'),'{}');await writeFile(join(source,'casimir'),'wrapper');const archive=join(root,'bundle.tar'),target=join(root,'target');
 const pack=()=>execFileSync('tar',['-cf',archive,'-C',source,'.']);const run=async(hash)=>spawnSync('sh',[new URL('../extract-bundle',import.meta.url).pathname,archive,hash??createHash('sha256').update(await readFile(archive)).digest('hex'),target],{encoding:'utf8'});
 pack();assert.notEqual((await run('0'.repeat(64))).status,0);await assert.rejects(()=>stat(target),{code:'ENOENT'});
 assert.equal((await run()).status,0);assert.equal(await readFile(join(target,'casimir'),'utf8'),'wrapper');assert.notEqual((await run()).status,0);await rm(target,{recursive:true});
 await symlink('/etc/passwd',join(source,'link'));pack();assert.notEqual((await run()).status,0);await assert.rejects(()=>stat(target),{code:'ENOENT'});await rm(join(source,'link'));
 execFileSync('tar',['-cf',archive,'--transform=s@bundle.json@../escape@','-C',source,'bundle.json','casimir']);assert.notEqual((await run()).status,0);await assert.rejects(()=>stat(join(root,'escape')),{code:'ENOENT'});
});
