import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,realpath,rename,rm,link,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
const magic=Buffer.from('CASIMIR-BACKUP-1\n');
const maxBytes=16*1024**3,maxFiles=100000,maxManifest=4*1024**2;
type Metadata={format:1;installationId:string;bundleVersion:string;references:string[]};
type Entry={path:string;bytes:number;sha256:string};
function pathName(path:string):void{if(typeof path!=='string'||path.length>1024||!/^[A-Za-z0-9_./-]+$/.test(path)||path.startsWith('/')||path.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('backup_path_invalid');}
async function digest(path:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function keyFile(path:string):Promise<Buffer>{const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.size!==32||(s.mode&0o777)!==0o600)throw new Error('backup_key_requires_private_32_bytes');return await f.readFile();}finally{await f.close();}}
async function catalog(root:string,prefix=''):Promise<Entry[]>{const entries:Entry[]=[];for(const e of await readdir(join(root,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+e.name:e.name;pathName(path);if(e.isDirectory())entries.push(...await catalog(root,path));else if(e.isFile()){const s=await lstat(join(root,path));entries.push({path,bytes:s.size,sha256:await digest(join(root,path))});}else throw new Error('backup_regular_files_only');}return entries.sort((a,b)=>a.path.localeCompare(b.path));}
function validate(meta:Metadata,files:Entry[]):void{
 if(!meta||Object.keys(meta).sort().join(',')!=='bundleVersion,format,installationId,references'||meta.format!==1||!/^[a-f0-9]{32}$/.test(meta.installationId)||!/^c1\.[0-9]+$/.test(meta.bundleVersion)||!Array.isArray(meta.references)||!Array.isArray(files)||files.length>maxFiles)throw new Error('backup_inventory_invalid');
 const paths=new Set<string>();let total=0;
 for(const f of files){pathName(f.path);if(Object.keys(f).sort().join(',')!=='bytes,path,sha256'||paths.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error('backup_inventory_file');paths.add(f.path);total+=f.bytes;}
 if(total>maxBytes||meta.references.some(p=>!paths.has(p)))throw new Error('backup_reference_or_size_invalid');
}
async function parent(path:string):Promise<void>{if(resolve(path)!==path||await realpath(dirname(path))!==dirname(path))throw new Error('backup_canonical_parent_required');}
async function syncDir(path:string):Promise<void>{const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
export async function writeEncryptedBackup(source:string,output:string,keyPath:string,metadata:Metadata):Promise<void>{
 await parent(output);const key=await keyFile(keyPath),files=await catalog(source);validate(metadata,files);
 const inventory=Buffer.from(JSON.stringify({metadata,files}));if(inventory.length>maxManifest)throw new Error('backup_inventory_size');
 const size=Buffer.alloc(4);size.writeUInt32BE(inventory.length);const nonce=randomBytes(12),header=Buffer.concat([magic,nonce]);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);
 const temporary=output+'.'+randomBytes(16).toString('hex')+'.partial';
 const fd=await open(temporary,'wx',0o600);await fd.writeFile(header);await fd.close();
 async function* plaintext(){yield size;yield inventory;for(const f of files){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(join(source,f.path))){bytes+=chunk.length;if(bytes>f.bytes)throw new Error('backup_source_changed');hash.update(chunk);yield chunk;}if(bytes!==f.bytes||hash.digest('hex')!==f.sha256)throw new Error('backup_source_changed');}}
 try{await pipeline(plaintext(),cipher,createWriteStream(temporary,{flags:'a',mode:0o600}));const f=await open(temporary,'a');try{await f.writeFile(cipher.getAuthTag());await f.sync();}finally{await f.close();}await link(temporary,output);await syncDir(dirname(output));}finally{key.fill(0);await rm(temporary,{force:true});}
}
export async function readEncryptedBackup(input:string,keyPath:string,destination:string,options:{expectedInputBytes?:number}={}):Promise<{metadata:Metadata;files:Entry[]}>{
 await parent(destination);try{await lstat(destination);throw new Error('restore_nonempty_target_refused');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const expected=options.expectedInputBytes;if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))throw new Error('backup_size');
 const key=await keyFile(keyPath);let source:Awaited<ReturnType<typeof open>>|undefined,staging:string|undefined,stagingCreated=false;
 try{
  source=await open(input,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await source.stat();
  const header=Buffer.alloc(magic.length+12),tag=Buffer.alloc(16);
  if(!info.isFile()||info.size<header.length+20||info.size>maxBytes+maxManifest+100||(expected!==undefined&&info.size!==expected))throw new Error('backup_size');
  staging=destination+'.'+randomBytes(16).toString('hex')+'.staging';await mkdir(staging,{mode:0o700});stagingCreated=true;const plaintext=join(staging,'.plaintext');
  await source.read(header,0,header.length,0);await source.read(tag,0,16,info.size-16);if(!header.subarray(0,magic.length).equals(magic))throw new Error('backup_format');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(magic.length));decipher.setAAD(header);decipher.setAuthTag(tag);
  // Unauthenticated plaintext goes only to this private staging file. It cannot
  // select paths or cause extraction, Docker or database writes before final().
  // Bind both the capacity check and ciphertext stream to the same opened file.
  await pipeline(createReadStream(input,{fd:source.fd,autoClose:false,start:header.length,end:info.size-17}),decipher,createWriteStream(plaintext,{flags:'wx',mode:0o600}));
  const plain=await open(plaintext,'r');let inventory:{metadata:Metadata;files:Entry[]};let offset=4;
  try{const length=Buffer.alloc(4);await plain.read(length,0,4,0);const n=length.readUInt32BE();if(n>maxManifest)throw new Error('backup_manifest_size');const bytes=Buffer.alloc(n);if((await plain.read(bytes,0,n,4)).bytesRead!==n)throw new Error('backup_truncated');inventory=JSON.parse(bytes.toString('utf8'));if(Object.keys(inventory).sort().join(',')!=='files,metadata')throw new Error('backup_inventory_fields');validate(inventory.metadata,inventory.files);offset+=n;if((await plain.stat()).size!==offset+inventory.files.reduce((n,f)=>n+f.bytes,0))throw new Error('backup_payload_size');}finally{await plain.close();}
  for(const f of inventory.files){const output=join(staging,'files',f.path);await mkdir(dirname(output),{recursive:true,mode:0o700});if(f.bytes)await pipeline(createReadStream(plaintext,{start:offset,end:offset+f.bytes-1}),createWriteStream(output,{flags:'wx',mode:0o600}));else await writeFile(output,'',{flag:'wx',mode:0o600});if(await digest(output)!==f.sha256)throw new Error('backup_payload_hash');offset+=f.bytes;}
  await writeFile(join(staging,'inventory.json'),JSON.stringify(inventory),{mode:0o600,flag:'wx'});await rm(plaintext);await rename(staging,destination);stagingCreated=false;await syncDir(dirname(destination));return inventory;
 }finally{key.fill(0);if(source)await source.close();if(staging&&stagingCreated)await rm(staging,{recursive:true,force:true});}
}
