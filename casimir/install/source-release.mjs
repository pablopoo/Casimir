import {createHash} from 'node:crypto';import {join} from 'node:path';
import {readPrivate,atomicPrivateJson} from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
export async function recordSourceRelease(state,text,expectedHash){
 if(createHash('sha256').update(text).digest('hex')!==expectedHash)throw new Error('source_release_hash');
 const value={format:1,text};if(Buffer.byteLength(JSON.stringify(value))>65536)throw new Error('source_release_size');
 try{const prior=await readPrivate(join(state,'source-release.json'));if(prior.format!==1||prior.text!==text)throw new Error('source_release_conflict');return;}catch(e){if(e.code!=='ENOENT')throw e;}
 await atomicPrivateJson(join(state,'source-release.json'),value);
}
export async function readSourceRelease(state,expectedHash){const value=await readPrivate(join(state,'source-release.json'));if(value.format!==1||typeof value.text!=='string'||createHash('sha256').update(value.text).digest('hex')!==expectedHash)throw new Error('source_release_hash');return JSON.parse(value.text);}
