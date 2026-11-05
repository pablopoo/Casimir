import {execFileSync,spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {mkdir,copyFile,cp,readFile,writeFile,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {hashFile,payloadFiles,verifyBundle} from './bundle.mjs';
import {controlMigrationCatalog} from '../../platform/packages/api/src/casimir/lifecycle/control-migrations.ts';
import {publishPayloadPermissions} from './payload-permissions.mjs';
const [output,version,sourceRevision,controlId,runnerId,databaseId,ingressId]=process.argv.slice(2);
if(!output||!/^c1\.[0-9]+$/.test(version)||!/^[a-f0-9]{40}$/.test(sourceRevision)||[controlId,runnerId,databaseId,ingressId].some(id=>!/^sha256:[a-f0-9]{64}$/.test(id)))throw new Error('explicit_output_version_source_and_four_image_ids_required');
const catalog=await controlMigrationCatalog(version);
const root=resolve(output);await mkdir(root,{mode:0o755});
for(const dir of ['images','sdk','templates','sql','reference-app','THIRD_PARTY_NOTICES'])await mkdir(join(root,dir));
for(const [source,target] of [['casimir/install/casimir','casimir'],['casimir/install/extract-bundle','extract-bundle'],['casimir/install/bundle.schema.json','bundle.schema.json'],['casimir/install/README.md','README.md'],['casimir/install/SUPPORT.md','SUPPORT.md'],['LICENSE','LICENSE'],['platform/packages/api/src/admin/react/themes/LICENSE','THIRD_PARTY_NOTICES/remdx-theme-MIT.txt']])await copyFile(source,join(root,target));
await writeFile(join(root,'compose.yaml'),'# Installation-specific Compose is generated under the explicit private --state directory.\n');
await writeFile(join(root,'templates/control.conf'),'# Fixed ingress configuration is generated from validated operator origins.\n');
await cp('casimir/examples/notes',join(root,'reference-app'),{recursive:true,filter:source=>!source.split('/').some(p=>['node_modules','.void','.local','dist'].includes(p))});
await cp('casimir/install/sdk',join(root,'sdk'),{recursive:true});
await cp('casimir/install/sdk',join(root,'reference-app/sdk'),{recursive:true});
await copyFile('casimir/install/consumer-pnpm-lock.yaml',join(root,'reference-app/pnpm-lock.yaml'));
const sdkCatalog=JSON.parse(await readFile('casimir/install/sdk/catalog.json','utf8'));
const overrides=Object.fromEntries(Object.entries(sdkCatalog).map(([name,value])=>[name,'file:./sdk/'+value.filename]));
await writeFile(join(root,'reference-app/package.json'),JSON.stringify({name:'casimir-bundle-consumer',private:true,type:'module',dependencies:{void:overrides.void,'@void/react':overrides['@void/react'],'@void/deploy-core':overrides['@void/deploy-core'],'@hono/node-server':'2.1.5',react:'19.3.0','react-dom':'19.3.0','better-sqlite3':'13.0.3'},devDependencies:{vite:'npm:@voidzero-dev/vite-plus-core@1.2.0','vite-plus':'1.2.0'}}));
await writeFile(join(root,'reference-app/pnpm-workspace.yaml'),['packages: []','allowBuilds:','  better-sqlite3: true','overrides:',...Object.entries(overrides).map(([name,value])=>'  '+JSON.stringify(name)+': '+JSON.stringify(value)),''].join('\n'));
await cp('platform/packages/api/drizzle',join(root,'sql/control'),{recursive:true});
await cp('casimir/mvp-a/migrations',join(root,'sql/artifacts'),{recursive:true});
await mkdir(join(root,'sql/lifecycle'));
for(const migration of catalog)await writeFile(join(root,'sql/lifecycle/'+String(migration.version).padStart(4,'0')+(migration.version===1?'_lifecycle.sql':'_upgrade_probe.sql')),migration.source);
const images=[];
for(const [role,id] of [['lifecycle',controlId],['control',controlId],['tooling',controlId],['runner',runnerId],['database',databaseId],['ingress',ingressId]]){
 const inspect=JSON.parse(execFileSync('docker',['image','inspect',id],{encoding:'utf8'}))[0];
 if(inspect.Id!==id||inspect.Os!=='linux'||inspect.Architecture!=='amd64')throw new Error('image_identity_platform');
 const existing=images.find(i=>i.imageId===id);let archive,sha256;
 if(existing)({archive,sha256}=existing);else{
  archive=`images/${role}.tar.gz`;const save=spawn('docker',['image','save',id],{stdio:['ignore','pipe','pipe']});
  const exited=new Promise((resolve,reject)=>{save.once('error',reject);save.once('close',resolve);});save.stderr.resume();
  const timeout=setTimeout(()=>save.kill('SIGTERM'),600000);
  try{await pipeline(save.stdout,createGzip({level:1}),createWriteStream(join(root,archive),{flags:'wx',mode:0o644}));if(await exited!==0)throw new Error('image_export_failed');}finally{clearTimeout(timeout);save.kill();}
  sha256=await hashFile(join(root,archive));
 }
 images.push({role,archive,sha256,imageId:id,repoDigests:inspect.RepoDigests??[]});
}
const bootstrap=images.find(i=>i.role==='lifecycle');await writeFile(join(root,'bootstrap.txt'),bootstrap.sha256+'\n'+bootstrap.imageId+'\n');
const files=[];for(const path of await payloadFiles(root)){const info=await stat(join(root,path));files.push({path,bytes:info.size,sha256:await hashFile(join(root,path))});}
const sdk=files.filter(f=>f.path.startsWith('sdk/')&&f.path.endsWith('.tgz')).map(({path,sha256})=>({path,sha256}));
const runtime=JSON.parse(await readFile('casimir/mvp-a/runner/dist/runtime.json','utf8'));
const migrations=files.filter(f=>f.path.startsWith('sql/lifecycle/')&&f.path.endsWith('.sql'));
const manifest={format:1,version,sourceRevision,platform:'linux/amd64',runtime,images,sdk,files,controlSchema:{version:catalog.length,migrationHashes:migrations.map(f=>f.sha256),readableBy:[version]},upgradeFrom:version==='c1.1'?['c1.0']:[]};
await writeFile(join(root,'bundle.json'),JSON.stringify(manifest,null,2)+'\n');await publishPayloadPermissions(root);await verifyBundle(root);
const wholeArchive=root+'.tar';execFileSync('tar',['-cf',wholeArchive,'-C',root,'.'],{timeout:600000});const archiveSha256=await hashFile(wholeArchive);
await writeFile(wholeArchive+'.sha256',archiveSha256+'\n');await copyFile('casimir/install/extract-bundle',root+'-extract');await chmod(root+'-extract',0o755);
console.log(JSON.stringify({version,sourceRevision,bytes:files.reduce((n,f)=>n+f.bytes,0),manifestHash:createHash('sha256').update(await readFile(join(root,'bundle.json'))).digest('hex'),wholeArchive,archiveSha256,images}));
