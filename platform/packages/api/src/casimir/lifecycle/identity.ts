import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseInstallConfig } from './config.ts';
import { deriveResources } from './resources.ts';
import type { InstallConfig, InstallReceipt } from './types.ts';
export type InstallIdentity = {format: 1; installationId: string; token: string; databasePassword: string; config: InstallConfig; bundleVersion: string; bundleHash: string};
export const OPERATION_INVENTORY_MAX_BYTES=768*1024;
const SMALL_PRIVATE_JSON_MAX_BYTES=65536;
export async function privateState(state: string): Promise<void> {
  if(!isAbsolute(state)||normalize(state)!==state||/[\0\r\n,]/.test(state)) throw new Error('state_requires_canonical_absolute_path');
  await mkdir(state,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST') throw e;});
  const s=await lstat(state);
  if(!s.isDirectory() || await realpath(state)!==state || (s.mode&0o777)!==0o700 || s.uid!==process.getuid?.()) throw new Error('state_requires_owned_private_directory_without_links');
}
export type PrivateFileOwner = Readonly<{uid:number;gid:number}>;
export async function atomicPrivateFile(path: string, contents: string, maxBytes=SMALL_PRIVATE_JSON_MAX_BYTES, owner?:PrivateFileOwner): Promise<void> {
  if(typeof contents!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<1||Buffer.byteLength(contents)>maxBytes)throw new Error('private_state_size_limit');
  if(owner&&(!Number.isSafeInteger(owner.uid)||owner.uid<0||!Number.isSafeInteger(owner.gid)||owner.gid<0))throw new Error('private_state_owner_invalid');
  const next=path+'.'+randomBytes(16).toString('hex')+'.next';
  try {
    const f=await open(next,'wx',0o600);
    try {await f.writeFile(contents);await f.sync();if(owner){await f.chown(owner.uid,owner.gid);await f.sync();}} finally {await f.close();}
    await rename(next,path);
    const d=await open(join(path,'..'),'r');try{await d.sync();}finally{await d.close();}
  } finally {await rm(next,{force:true});}
}
export async function atomicPrivateJson(path: string, value: unknown, maxBytes=SMALL_PRIVATE_JSON_MAX_BYTES, owner?:PrivateFileOwner): Promise<void> {
  await atomicPrivateFile(path,JSON.stringify(value)+'\n',maxBytes,owner);
}
export async function readPrivate(path: string, maxBytes=SMALL_PRIVATE_JSON_MAX_BYTES): Promise<any> {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('private_state_limit_invalid');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=await f.stat();if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.())throw new Error('private_state_invalid');
    if(s.size>maxBytes)throw new Error('private_state_size_limit');
    const bytes=Buffer.alloc(maxBytes+1),{bytesRead}=await f.read(bytes,0,bytes.length,0);
    if(bytesRead>maxBytes)throw new Error('private_state_size_limit');
    return JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
  } finally{await f.close();}
}
export async function withStateLock<T>(state: string, action: ()=>Promise<T>): Promise<T> {
  await privateState(state);
  const fd=await open(join(state,'.lock'),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  const child=spawn('sh',['-c','flock --nonblock 3 || exit 75; printf locked; cat >/dev/null'],{stdio:['pipe','pipe','pipe',fd.fd]});
  const ended=once(child,'exit');
  try {
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(new Error('installation_busy')));child.stdout!.once('data',chunk=>chunk.toString()==='locked'?resolve():reject(new Error('lock_failed')));});
    return await action();
  } finally {child.stdin!.end();await ended;await fd.close();}
}
function canonical(value: unknown): string {
  if(value && typeof value==='object' && !Array.isArray(value)) return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonical(v))])));
  return JSON.stringify(value);
}
export async function initializeInstallation(state: string, config: InstallConfig, bundle: {version: string;hash: string}, initializeDatabase: (identity: InstallIdentity)=>Promise<{operatorId: string;projectId: string}>,lockHeld=false): Promise<InstallReceipt> {
  parseInstallConfig(config);
  if(!/^c1\.[0-9]+$/.test(bundle.version)||!/^[a-f0-9]{64}$/.test(bundle.hash)) throw new Error('bundle_identity_invalid');
  const initialize=async()=>{
    const identityPath=join(state,'identity.json');let identity: InstallIdentity;
    try{identity=await readPrivate(identityPath);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('partial_identity_invalid_preserve_state');
      if((await readdir(state)).some(p=>p!=='.lock')) throw new Error('unknown_partial_state_preserve_and_inspect');
      identity={format:1,installationId:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex'),databasePassword:randomBytes(32).toString('hex'),config,bundleVersion:bundle.version,bundleHash:bundle.hash};
      await atomicPrivateJson(identityPath,identity);
    }
    if(Object.keys(identity).sort().join(',')!=='bundleHash,bundleVersion,config,databasePassword,format,installationId,token' || identity.format!==1 || !/^[a-f0-9]{64}$/.test(identity.token) || !/^[a-f0-9]{64}$/.test(identity.databasePassword) || canonical(identity.config)!==canonical(config) || identity.bundleVersion!==bundle.version || identity.bundleHash!==bundle.hash) throw new Error('existing_identity_or_config_mismatch');
    const resources=deriveResources(identity.installationId);
    const base: InstallReceipt={format:1,installationId:identity.installationId,operatorId:'',projectId:'',bundleVersion:identity.bundleVersion,bundleHash:identity.bundleHash,phase:'initializing',resources};
    let receipt: InstallReceipt;
    try{receipt=await readPrivate(join(state,'receipt.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;receipt=base;await atomicPrivateJson(join(state,'receipt.json'),receipt);}
    if(canonical({...receipt,phase:'initializing',operatorId:'',projectId:''})!==canonical(base) || !['initializing','ready','stopped','maintenance','recovery_required'].includes(receipt.phase) || (receipt.phase!=='initializing' && (!/^user_[a-z0-9]{12}$/.test(receipt.operatorId)||!/^proj_[a-z0-9]{12}$/.test(receipt.projectId)))) throw new Error('receipt_identity_mismatch');
    if(receipt.phase!=='initializing') return receipt;
    const ids=await initializeDatabase(identity);
    if(!/^user_[a-z0-9]{12}$/.test(ids.operatorId)||!/^proj_[a-z0-9]{12}$/.test(ids.projectId)) throw new Error('database_identity_invalid');
    receipt={...base,...ids,phase:'ready'};await atomicPrivateJson(join(state,'receipt.json'),receipt);return receipt;
  };return lockHeld?initialize():withStateLock(state,initialize);
}
