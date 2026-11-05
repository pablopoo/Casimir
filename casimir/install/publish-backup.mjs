import {open,link,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
// State and output are separate bind mounts even when backed by the same disk.
// Stage encrypted bytes beside the destination, then publish without overwrite.
export async function publishBackup(source,output){
 const parent=dirname(output),temporary=join(parent,'.casimir-backup-'+randomBytes(16).toString('hex'));
 let handle;
 try{
  handle=await open(temporary,'wx',0o600);
  const input=await open(source,'r');
  try{for await(const chunk of input.createReadStream()){await handle.writeFile(chunk);}await handle.sync();}
  finally{await input.close();await handle.close();handle=undefined;}
  await link(temporary,output);
  const directory=await open(parent,'r');try{await directory.sync();}finally{await directory.close();}
 }finally{if(handle)await handle.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
