import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hashPattern = /^[a-f0-9]{64}$/;
export function closed(value, fields, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== fields.split(',').sort().join(',')) throw new Error(`${name}: invalid fields`);
}
export function canonicalPath(path) {
  if (typeof path !== 'string' || path.length > 1024 || !/^[a-zA-Z0-9_@+./ -]+$/.test(path) || path.startsWith('/') || path.split('/').some(p=>!p || p==='.' || p==='..' || p.startsWith('.')) || /(^|\/)(node_modules|credentials)(\/|$)/.test(path)) throw new Error('invalid payload path');
  return path;
}
export async function hashFile(path) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function payloadFiles(root, prefix='') {
  const result=[];
  for (const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
    const path=prefix ? `${prefix}/${entry.name}` : entry.name;
    canonicalPath(path);
    if(entry.isDirectory()) result.push(...await payloadFiles(root,path));
    else if(entry.isFile()) result.push(path);
    else throw new Error('payload must contain regular files, not links or devices');
  }
  return result.sort();
}
export async function verifyBundle(root) {
  root=resolve(root);
  if(await realpath(root)!==root) throw new Error('bundle path must not contain links');
  const info=await lstat(join(root,'bundle.json'));
  if(!info.isFile() || info.size>4*1024*1024) throw new Error('invalid manifest regular file/size');
  const m=JSON.parse(await readFile(join(root,'bundle.json'),'utf8'));
  closed(m,'format,version,sourceRevision,platform,runtime,images,sdk,files,controlSchema,upgradeFrom','manifest');
  if(m.format!==1 || !/^c1\.[0-9]+$/.test(m.version) || !/^[a-f0-9]{40}$/.test(m.sourceRevision) || m.platform!=='linux/amd64') throw new Error('unsupported bundle identity');
  closed(m.runtime,'protocol,profile,sdkVersion,runtimeId,platform,nodeAbi','runtime');
  if(m.runtime.protocol!==1 || m.runtime.profile!=='node-sqlite-v1' || m.runtime.platform!==m.platform || m.runtime.nodeAbi!=='137' || !hashPattern.test(m.runtime.runtimeId) || typeof m.runtime.sdkVersion!=='string') throw new Error('unsupported runtime');
  closed(m.controlSchema,'version,migrationHashes,readableBy','control schema');
  if(!Number.isSafeInteger(m.controlSchema.version) || m.controlSchema.version<1 || !Array.isArray(m.controlSchema.migrationHashes) || !m.controlSchema.migrationHashes.length || !m.controlSchema.migrationHashes.every(h=>hashPattern.test(h)) || !Array.isArray(m.controlSchema.readableBy) || !m.controlSchema.readableBy.includes(m.version) || !m.controlSchema.readableBy.every(v=>/^c1\.[0-9]+$/.test(v)) || !Array.isArray(m.upgradeFrom) || !m.upgradeFrom.every(v=>/^c1\.[0-9]+$/.test(v))) throw new Error('invalid schema compatibility');
  if(!Array.isArray(m.files) || m.files.length>20000 || !Array.isArray(m.images) || !Array.isArray(m.sdk)) throw new Error('invalid payload catalog');
  const catalog=new Map();
  for(const f of m.files) {
    closed(f,'path,bytes,sha256','file'); canonicalPath(f.path);
    if(f.path==='bundle.json' || catalog.has(f.path)) throw new Error('duplicate/self payload path');
    if(!Number.isSafeInteger(f.bytes) || f.bytes<0 || !hashPattern.test(f.sha256)) throw new Error('invalid file size/hash');
    catalog.set(f.path,f);
  }
  const actual=(await payloadFiles(root)).filter(p=>p!=='bundle.json');
  if(actual.join('\0')!==[...catalog.keys()].sort().join('\0')) throw new Error('missing or extra payload file');
  for(const [path,f] of catalog) {
    if((await lstat(join(root,path))).size!==f.bytes) throw new Error(`payload size mismatch: ${path}`);
    if(await hashFile(join(root,path))!==f.sha256) throw new Error(`payload hash mismatch: ${path}`);
  }
  const roles=new Set();
  for(const image of m.images) {
    closed(image,'role,archive,sha256,imageId,repoDigests','image');
    if(!Array.isArray(image.repoDigests)||image.repoDigests.some(d=>typeof d!=='string'||!/^[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}$/.test(d)))throw new Error('invalid image registry digest');
    if(roles.has(image.role) || !['lifecycle','control','runner','tooling','database','ingress'].includes(image.role) || !/^sha256:[a-f0-9]{64}$/.test(image.imageId) || !image.archive.startsWith('images/') || catalog.get(image.archive)?.sha256!==image.sha256) throw new Error('invalid image payload');
    roles.add(image.role);
  }
  if(roles.size!==6 || !m.sdk.length) throw new Error('missing image or sdk payload');
  const sdk=new Set();
  for(const entry of m.sdk) {
    closed(entry,'path,sha256','sdk');
    if(sdk.has(entry.path) || !entry.path.startsWith('sdk/') || !entry.path.endsWith('.tgz') || catalog.get(entry.path)?.sha256!==entry.sha256) throw new Error('invalid sdk payload');
    sdk.add(entry.path);
  }
  for(const path of ['casimir','compose.yaml','README.md','LICENSE']) if(!catalog.has(path)) throw new Error(`missing payload: ${path}`);
  for(const prefix of ['reference-app/','templates/','sql/']) if(!actual.some(p=>p.startsWith(prefix))) throw new Error(`missing payload: ${prefix}`);
  return m;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const m=await verifyBundle(process.argv[2]); console.log(JSON.stringify({verified:true,version:m.version,sourceRevision:m.sourceRevision}));}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
