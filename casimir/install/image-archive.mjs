import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
// tar writes selected regular file contents to stdout only: never extracts to disk.
export async function verifyImageArchive(path,imageId){
 const get=name=>execFileSync('tar',['-xOf',path,'--',name],{maxBuffer:4*1024*1024,timeout:120000,stdio:['ignore','pipe','pipe']});
 const manifest=JSON.parse(get('manifest.json').toString('utf8'));
 if(!Array.isArray(manifest)||manifest.length!==1||!/^([a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(manifest[0].Config))throw new Error('archive_identity_manifest');
 const bytes=get(manifest[0].Config),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const config=JSON.parse(bytes.toString('utf8'));
 if(hash!==imageId)throw new Error('archive_image_identity');
 if(config.os!=='linux'||config.architecture!=='amd64')throw new Error('archive_platform');
}
