import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const api=await import('../image-archive.mjs').catch(()=>({}));
test('image_archive_identity_and_architecture_are_verified_before_load',async t=>{
 assert.equal(typeof api.verifyImageArchive,'function');const p=await mkdtemp(join(tmpdir(),'c1-image-'));t.after(()=>rm(p,{recursive:true,force:true}));
 const config=JSON.stringify({architecture:'amd64',os:'linux',rootfs:{type:'layers',diff_ids:[]}}),id=createHash('sha256').update(config).digest('hex');
 await writeFile(join(p,id+'.json'),config);await writeFile(join(p,'manifest.json'),JSON.stringify([{Config:id+'.json',RepoTags:[],Layers:[]}]));execFileSync('tar',['--format=ustar','-cf',join(p,'image.tar'),'-C',p,'manifest.json',id+'.json']);
 await api.verifyImageArchive(join(p,'image.tar'),'sha256:'+id);await assert.rejects(()=>api.verifyImageArchive(join(p,'image.tar'),'sha256:'+'a'.repeat(64)),/identity/);
 await writeFile(join(p,id+'.json'),JSON.stringify({architecture:'arm64',os:'linux'}));execFileSync('tar',['--format=ustar','-cf',join(p,'image.tar'),'-C',p,'manifest.json',id+'.json']);await assert.rejects(()=>api.verifyImageArchive(join(p,'image.tar'),'sha256:'+id),/identity|platform/);
});
test('compressed_image_archive_preserves_actual_image_identity',async t=>{
 const p=await mkdtemp(join(tmpdir(),'c1-gzip-'));t.after(()=>rm(p,{recursive:true,force:true}));const config=JSON.stringify({architecture:'amd64',os:'linux',rootfs:{type:'layers',diff_ids:[]}}),id=createHash('sha256').update(config).digest('hex');
 await writeFile(join(p,id+'.json'),config);await writeFile(join(p,'manifest.json'),JSON.stringify([{Config:id+'.json',RepoTags:[],Layers:[]}]));execFileSync('tar',['--format=ustar','-czf',join(p,'image.tar.gz'),'-C',p,'manifest.json',id+'.json']);await api.verifyImageArchive(join(p,'image.tar.gz'),'sha256:'+id);await assert.rejects(()=>api.verifyImageArchive(join(p,'image.tar.gz'),'sha256:'+'a'.repeat(64)),/identity/);
});
