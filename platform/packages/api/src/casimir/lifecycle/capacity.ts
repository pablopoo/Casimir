import {statfs} from 'node:fs/promises';
import type {MvpProfile} from '../mvp/types.ts';
import {LocalHttpError} from '../project-service.ts';
export async function assertAdmissionCapacity(profile:MvpProfile,bytes:unknown=0){
 if(!profile.installationId)return;
 const requested=typeof bytes==='number'&&Number.isSafeInteger(bytes)&&bytes>0?BigInt(bytes):0n;
 const disk=await statfs(profile.artifactRoot,{bigint:true});
 if(disk.bavail*disk.bsize<20n*1024n**3n+3n*requested)throw new LocalHttpError(507,'installation_disk_reserve');
}
