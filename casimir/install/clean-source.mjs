// Build-only cleanup inside the dependency image; retain installed dependency trees.
import {readdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
export async function clearInheritedSource(root){
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.name==='node_modules')continue;
  const path=join(root,entry.name);
  if(entry.isDirectory()){await clearInheritedSource(path);if(!(await readdir(path)).length)await rm(path,{recursive:true});}
  else await rm(path);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv[2]!=='/src')throw new Error('build_cleanup_requires_src');await clearInheritedSource('/src');}
