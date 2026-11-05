import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {publishBackup} from '../publish-backup.mjs';
test('encrypted publication is private and refuses overwrite without leaving staging files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'publish-backup-'));
 try{const source=join(dir,'source'),output=join(dir,'output');await writeFile(source,'synthetic encrypted bytes');await publishBackup(source,output);assert.equal(await readFile(output,'utf8'),'synthetic encrypted bytes');assert.equal((await stat(output)).mode&0o777,0o600);await writeFile(source,'changed');await assert.rejects(publishBackup(source,output),{code:'EEXIST'});assert.equal(await readFile(output,'utf8'),'synthetic encrypted bytes');assert.deepEqual((await readdir(dir)).sort(),['output','source']);}finally{await rm(dir,{recursive:true,force:true});}
});
