import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,cp,stat} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';
const mode=process.argv[2]??'prepare',root='/tmp/casimir-consumer',bundle='/bundle';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
async function run(command,args,env=process.env){return new Promise((resolve,reject)=>{let output='';const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>child.kill('SIGTERM'),660000);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;if(output.length>12*1024**2)child.kill('SIGTERM');});child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(output);else reject(new Error('client_command_failed:'+command+':'+code+'\n'+output.replaceAll(env.CASIMIR_TOKEN??'__no_token__','[redacted]')));});});}
if(mode==='prepare'){
 await mkdir(root);await cp(join(bundle,'reference-app'),root,{recursive:true});const catalog=await json(join(bundle,'sdk/catalog.json'));
 await cp(join(bundle,'sdk'),join(root,'sdk'),{recursive:true});
 const overrides=Object.fromEntries(Object.entries(catalog).map(([name,value])=>[name,'file:./sdk/'+value.filename]));
 await writeFile(join(root,'package.json'),JSON.stringify({name:'casimir-bundle-consumer',private:true,type:'module',dependencies:{void:overrides.void,'@void/react':overrides['@void/react'],'@void/deploy-core':overrides['@void/deploy-core'],'@hono/node-server':'2.1.5',react:'19.3.0','react-dom':'19.3.0','better-sqlite3':'13.0.3'},devDependencies:{vite:'npm:@voidzero-dev/vite-plus-core@1.2.0','vite-plus':'1.2.0'}}));
 await writeFile(join(root,'pnpm-workspace.yaml'),['packages: []','allowBuilds:','  better-sqlite3: true','overrides:',...Object.entries(overrides).map(([n,v])=>'  '+JSON.stringify(n)+': '+JSON.stringify(v)),''].join('\n'));
 await writeFile(join(root,'.env'),'SERVER_ONLY=synthetic-build-placeholder\n',{mode:0o600});
 await writeFile(join(root,'routes/api/version.ts'),"import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:'v1'}));\n");
 const locked=await stat(join(root,'pnpm-lock.yaml')).then(()=>true,()=>false);
 console.log(await run('pnpm',['install',process.env.CASIMIR_PREPARE_NETWORK==='1'?'--prefer-offline':'--offline',...(locked?['--frozen-lockfile']:[]),'--ignore-scripts']));console.log(await run('pnpm',['rebuild','better-sqlite3']));
 console.log(await run(process.execPath,['--input-type=module','-e',"import Database from 'better-sqlite3';const db=new Database(':memory:');if(db.prepare('select 42 n').get().n!==42)process.exit(1);db.close();console.log('native_driver_loaded')"]));
 console.log(process.env.CASIMIR_PREPARE_NETWORK==='1'?'reference_dependency_cache_prepared':'packed_sdk_consumer_prepared_offline');
}else{
 const config=await json('/config/operator.json'),env={...process.env,CASIMIR_TOKEN:config.token,CASIMIR_API_URL:config.controlOrigin,CASIMIR_CONFIG_DIR:'/tmp/casimir-client-config'};
 const cli=join(root,'node_modules/void/dist/cli/cli.mjs');
 if(mode==='update')await writeFile(join(root,'routes/api/version.ts'),"import {defineHandler} from 'void';export const GET=defineHandler(()=>({version:'v2'}));\n");
 if(mode==='deploy')console.log(await run(process.execPath,[cli,'connect','--platform','casimir',config.controlOrigin],env));
 console.log(await run(process.execPath,[cli,'deploy','--project','casimir-reference'],env));
 const retry=await json(join(root,'.void/casimir.retry.json'));assert.equal(retry.finished,true);assert.equal((await stat(join(root,'.void/casimir.retry.json'))).mode&0o077,0);
 const view=await(await fetch(config.controlOrigin+'/casimir/v1/projects/'+config.projectId+'/operations/'+retry.receipt.operationId,{headers:{Authorization:'Bearer '+config.token}})).json();assert.equal(view.phase,'succeeded');
 const response=await fetch(config.appOrigin+'/');assert.equal(response.status,200);assert.equal(response.headers.get('x-casimir-image'),view.verifiedServing.imageId);assert.match(await response.text(),/Casimir notes/);
 console.log(JSON.stringify({phase:view.phase,projectId:config.projectId,artifactId:retry.artifactId,operationId:retry.receipt.operationId,serving:view.verifiedServing}));
}
