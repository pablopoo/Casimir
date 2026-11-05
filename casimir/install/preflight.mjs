import {execFileSync} from 'node:child_process';
import {statfs,stat,realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
export const MAX_BACKUP_INPUT_BYTES=16*1024**3+4*1024**2+100;
const GIB=1024**3,MIN_FREE_BYTES=20*GIB;
export function restoreDiskRequirement(bundleBytes,backupInputBytes){
 if(!Number.isSafeInteger(bundleBytes)||bundleBytes<0||!Number.isSafeInteger(backupInputBytes)||backupInputBytes<0||backupInputBytes>MAX_BACKUP_INPUT_BYTES)throw new Error('restore_backup_size');
 // The encrypted input already occupies its source path. Restore can add a
 // plaintext archive and an extracted tree while authenticating, then retain
 // the tree while loading image layers and importing database state. Reserve
 // those phase peaks explicitly, then preserve the strict free-space floor.
 const backupPeak=2n*BigInt(backupInputBytes);
 const imageLoadPeak=3n*BigInt(bundleBytes);
 const minimumReserve=BigInt(MIN_FREE_BYTES);
 return backupPeak+imageLoadPeak+minimumReserve;
}
export function qualifyRestoreDiskCapacity(availableBytes,bundleBytes,backupInputBytes){
 const available=BigInt(availableBytes),required=restoreDiskRequirement(bundleBytes,backupInputBytes);
 return {ok:available>=required,availableBytes:available.toString(),requiredBytes:required.toString()};
}
export async function preflightRestoreDisk({statePath,bundleBytes,backupInputBytes}){
 const disk=await statfs(statePath,{bigint:true}),available=disk.bavail*disk.bsize;
 return qualifyRestoreDiskCapacity(available,bundleBytes,backupInputBytes);
}
export function qualifyVersions(engine,compose){
 const a=/^(\d+)\.(\d+)\.(\d+)$/.exec(engine),b=/^(?:Docker Compose version )?v?(\d+)\.(\d+)\.(\d+)$/.exec(compose.trim());
 if(!a||!b||a.slice(1).map(Number).join('.')!=='29.9.1'||b.slice(1).map(Number).join('.')!=='5.6.0')throw new Error('unqualified_docker_version_requires_29.9.1_and_compose_5.6.0');return true;
}
export async function preflight({stateParent,statePath=stateParent,config,bundleBytes=0}){
 const version=JSON.parse(execFileSync('docker',['version','--format','{{json .Server}}'],{encoding:'utf8'}));
 const info=JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'}));
 qualifyVersions(version.Version,execFileSync('docker',['compose','version'],{encoding:'utf8'}));
 const codes=[];
 if(version.Os!=='linux'||version.Arch!=='amd64'||info.SecurityOptions?.some(s=>s.includes('rootless')))codes.push('requires_linux_amd64_rootful_docker');
 if(info.NCPU<2||info.MemTotal<8*1024**3)codes.push('requires_2cpu_8gib');
 const socket=await stat('/var/run/docker.sock');if(!socket.isSocket())codes.push('requires_local_unix_socket');
 if(await realpath(stateParent)!==stateParent)codes.push('state_parent_contains_link');
 const disk=await statfs(statePath,{bigint:true});const available=disk.bavail*disk.bsize;
 if(available<BigInt(Math.max(20*1024**3,3*bundleBytes+10*1024**3)))codes.push('insufficient_installation_disk');
 for(const port of [config.controlPort,config.appPort])await new Promise(resolve=>{
  const server=createServer();server.once('error',()=>{codes.push('bind_unavailable_'+port);resolve();});server.listen(port,config.bindAddress,()=>server.close(resolve));
 });
 return {ok:codes.length===0,codes,availableBytes:available.toString(),engine:version.Version,compose:'5.6.0'};
}
