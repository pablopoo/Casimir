import {chmod,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
// Bundle payload is public product material. Private installation state is never
// passed here or included in a bundle. Refuse links rather than following them.
export async function publishPayloadPermissions(root){
 async function walk(path,relative){const s=await lstat(path);if(s.isDirectory()){await chmod(path,0o755);for(const name of await readdir(path))await walk(join(path,name),relative?relative+'/'+name:name);}else if(s.isFile())await chmod(path,relative==='casimir'?0o755:0o644);else throw new Error('nonregular_bundle_payload');}
 await walk(root,'');
}
