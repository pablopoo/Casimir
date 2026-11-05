import { execFileSync } from 'node:child_process';
import { readFile, writeFile, chmod, chown, stat, rm } from 'node:fs/promises';
import { join, dirname,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeInstallation,withStateLock,readPrivate,atomicPrivateJson } from '../../platform/packages/api/src/casimir/lifecycle/identity.ts';
import { prepareCasimirManagementOwner,publishCasimirManagementConfig } from '../../platform/packages/api/src/casimir/management/management-files.ts';
import { deriveResources, deriveIdentityEgressNetwork, assertOwnedResource } from '../../platform/packages/api/src/casimir/lifecycle/resources.ts';
import { parseInstallConfig } from '../../platform/packages/api/src/casimir/lifecycle/config.ts';
import { verifyBundle } from './bundle.mjs';
import {verifyImageArchive} from './image-archive.mjs';
import {preflight} from './preflight.mjs';
import {validateCertificates,tlsConfig} from './tls.mjs';
import {recordSourceRelease} from './source-release.mjs';
export function dockerFailureCode(stderr){return /(?:Error response from daemon: (?:network [a-zA-Z0-9_.-]+ not found|get [a-zA-Z0-9_.-]+: no such volume|No such (?:image|container):)|Error: No such object:)/i.test(String(stderr))?'not_found':'docker_failed';}
export function docker(args, options={}) {
 try{return execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000,...options});}
 catch (error) {const e=new Error('docker_operation_failed:'+args.slice(0,2).join('_'));e.code=dockerFailureCode(error.stderr);throw e;}
}
export function enableManagementConfig(compose,state){
 const api=compose?.services?.api;if(!api||!Array.isArray(api.volumes))throw new Error('management_compose_api_missing');
 const source=join(state,'management.json'),target='/config/management.json';
 const existing=api.volumes.filter(volume=>volume&&typeof volume==='object'&&(volume.source===source||volume.target===target));
 if(existing.length>1||(existing.length===1&&(existing[0].source!==source||existing[0].target!==target||existing[0].type!=='bind'||existing[0].read_only!==true)))throw new Error('management_compose_conflict');
 for(const [name,service]of Object.entries(compose.services))if(name!=='api'&&(service.volumes??[]).some(volume=>volume&&typeof volume==='object'&&(volume.source===source||volume.target===target)))throw new Error('management_compose_exposure');
 if(!existing.length)api.volumes.push({type:'bind',source,target,read_only:true});
 return compose;
}
export function enableIdentityEgressNetwork(compose,installationId){
 const api=compose?.services?.api;
 if(!api||!Array.isArray(api.networks)||!compose.networks||typeof compose.networks!=='object'||Array.isArray(compose.networks))throw new Error('identity_egress_compose_invalid');
 const name=deriveIdentityEgressNetwork(installationId),network=compose.networks['identity-egress'];
 if(network&&(
  network.name!==name||network.internal!==false||
  network.labels?.['org.casimir.task']!=='c1'||
  network.labels?.['org.casimir.installation']!==installationId
 ))throw new Error('identity_egress_compose_conflict');
 compose.networks['identity-egress']={name,internal:false,labels:{'org.casimir.task':'c1','org.casimir.installation':installationId}};
 for(const [serviceName,service]of Object.entries(compose.services)){
  if(serviceName==='api')continue;
  const networks=service?.networks;
  if(Array.isArray(networks)&&networks.includes('identity-egress'))throw new Error('identity_egress_compose_exposure');
  if(networks&&typeof networks==='object'&&!Array.isArray(networks)&&Object.hasOwn(networks,'identity-egress'))throw new Error('identity_egress_compose_exposure');
 }
 if(!api.networks.includes('runtime'))throw new Error('identity_egress_compose_invalid');
 if(!api.networks.includes('identity-egress'))api.networks.push('identity-egress');
 return compose;
}
export function addManagementConfigToApiEnv(contents){
 if(typeof contents!=='string')throw new Error('management_api_environment');
 const lines=contents.split(/\r?\n/),entries=lines.filter(line=>line.startsWith('CASIMIR_MANAGEMENT_CONFIG='));
 if(entries.length>1||(entries.length===1&&entries[0]!=='CASIMIR_MANAGEMENT_CONFIG=/config/management.json'))throw new Error('management_api_environment');
 if(entries.length===1)return contents.endsWith('\n')?contents:contents+'\n';
 return (contents.endsWith('\n')?lines.slice(0,-1):lines).concat('CASIMIR_MANAGEMENT_CONFIG=/config/management.json').join('\n')+'\n';
}
export function assertInstallResourcesOwned(installationId,config,inspect=docker){
 const r=deriveResources(installationId);
 for(const [kind,names]of [['volume',Object.values(r.volumes)],['network',[r.runtimeNetwork,r.appsNetwork,r.frontNetwork,deriveIdentityEgressNetwork(installationId)]],['container',['db','api','executor','init','migrate','management-state-preflight','control-ingress','app-ingress',...(config.mode==='tls'?['tls-ingress']:[])].map(name=>r.scope+'-'+name)]])for(const name of names){let found;try{found=JSON.parse(inspect([kind,'inspect',name]))[0];}catch(error){if(error.code!=='not_found')throw error;}if(found)assertOwnedResource(found,installationId);}
}
export async function runWithOwnedInstallResources(installationId,config,operation,inspect=docker){
 assertInstallResourcesOwned(installationId,config,inspect);
 return operation();
}
export function renderCompose({installationId,state,images,uid,gid,socketGid,config,managementConfig=false,identityEgress=false}) {
 const r=deriveResources(installationId),labels={'org.casimir.task':'c1','org.casimir.installation':installationId};
 const common={image:images.control,pull_policy:'never',working_dir:'/src',init:true,user:'1000:1000',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'512m',cpus:1,pids_limit:128,tmpfs:['/tmp:rw,nosuid,size=32m'],logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}};
 const ingress={image:images.ingress,pull_policy:'never',user:'101:101',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'128m',cpus:0.25,pids_limit:64,tmpfs:['/tmp:rw,nosuid,size=16m'],logging:common.logging,restart:'unless-stopped'};
 const label=role=>({...labels,'org.casimir.scope':r.scope,'org.casimir.role':role});
 const mount=(file,target)=>({type:'bind',source:join(state,file),target,read_only:true});
 const result={name:r.scope,services:{
 db:{image:images.database,pull_policy:'never',container_name:r.dbContainer,env_file:join(state,'db.env'),networks:['runtime'],volumes:['database:/var/lib/postgresql'],labels:label('database'),mem_limit:'512m',cpus:1,pids_limit:128,restart:'unless-stopped',logging:common.logging,healthcheck:{test:['CMD-SHELL','pg_isready -U casimir -d casimir'],interval:'2s',timeout:'3s',retries:30}},
 init:{...common,container_name:r.scope+'-init',user:'0:0',cap_add:['CHOWN'],network_mode:'none',command:['node','casimir/mvp-a/init-volumes.mjs'],volumes:['artifacts:/artifacts','runtime-secrets:/runtime','jobs:/jobs','snapshots:/snapshots','appdata:/data','routes:/routes'],labels:label('init')},
 migrate:{...common,container_name:r.scope+'-migrate',user:`${uid}:${gid}`,env_file:join(state,'database.env'),environment:{CASIMIR_INSTALLATION_ID:installationId,CASIMIR_BUNDLE_VERSION:'c1.0',CASIMIR_BOOTSTRAP_RESULT:'/state/bootstrap-result.json'},networks:['runtime'],depends_on:{db:{condition:'service_healthy'}},command:['sh','-ec','node casimir/migrate.mjs && node casimir/mvp-a/migrate.mjs && node casimir/install/bootstrap-job.mjs'],volumes:[{type:'bind',source:state,target:'/state'}],labels:label('migrate')},
 api:{...common,command:['node','casimir/dist/main.mjs'],container_name:r.scope+'-api',restart:'unless-stopped',env_file:join(state,'api.env'),environment:{CASIMIR_MVP_PROFILE:'/config/profile.json'},networks:['runtime'],volumes:[mount('profile.json','/config/profile.json'),'artifacts:/artifacts'],depends_on:{migrate:{condition:'service_completed_successfully'},init:{condition:'service_completed_successfully'}},labels:label('api'),healthcheck:{test:['CMD','node','-e','fetch("http://127.0.0.1:3000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'],interval:'2s',timeout:'3s',retries:30}},
 executor:{...common,container_name:r.executorContainer,restart:'unless-stopped',env_file:join(state,'database.env'),environment:{CASIMIR_MVP_PROFILE:'/config/profile.json'},group_add:[String(socketGid)],command:['node','casimir/dist/mvpExecutor.mjs'],networks:['runtime','apps'],volumes:[{type:'bind',source:'/var/run/docker.sock',target:'/var/run/docker.sock'},mount('profile.json','/config/profile.json'),mount('runner.json','/config/runner.json'),mount('runtime-env.json','/config/runtime-env.json'),'artifacts:/artifacts','routes:/routes','runtime-secrets:/runtime','jobs:/jobs'],depends_on:{api:{condition:'service_healthy'},'app-ingress':{condition:'service_started'}},labels:label('executor')},
 'control-ingress':{...ingress,container_name:r.scope+'-control-ingress',entrypoint:['nginx','-c','/etc/nginx/casimir.conf','-g','daemon off;'],ports:[`${config.bindAddress}:${config.controlPort}:8080`],networks:['runtime','front'],volumes:[mount('control.conf','/etc/nginx/casimir.conf')],depends_on:{api:{condition:'service_healthy'}},labels:label('control-ingress')},
 'app-ingress':{...ingress,container_name:r.appIngressContainer,entrypoint:['nginx','-c','/routes/route.conf','-g','daemon off;'],ports:[`${config.bindAddress}:${config.appPort}:8080`],networks:['apps','front'],volumes:['routes:/routes:ro'],depends_on:{init:{condition:'service_completed_successfully'}},labels:label('app-ingress')}
 },networks:Object.fromEntries(['runtime','apps','front'].map(role=>[role,{name:r[role+'Network'],internal:role!=='front',labels}])),volumes:Object.fromEntries(Object.entries(r.volumes).map(([role,name])=>[role==='runtimeSecrets'?'runtime-secrets':role,{name,labels}]))};
 result.services['app-ingress'].entrypoint=['sh','-ec','cp /config/closed.conf /tmp/active.conf; exec nginx -c /tmp/active.conf -g "daemon off;"'];
 result.services['app-ingress'].volumes.push(mount('closed.conf','/config/closed.conf'));
 result.services.operator={...common,profiles:['operator'],group_add:[String(socketGid)],env_file:join(state,'database.env'),environment:{CASIMIR_MVP_PROFILE:'/config/profile.json'},networks:['runtime','apps','front'],command:['node','casimir/dist/lifecycle.mjs','status'],volumes:[{type:'bind',source:'/var/run/docker.sock',target:'/var/run/docker.sock'},mount('profile.json','/config/profile.json'),mount('runner.json','/config/runner.json'),'routes:/routes:ro','artifacts:/artifacts:ro','jobs:/jobs'],labels:label('operator')};
 if(config.mode!=='loopback')result.services.operator.volumes.push(mount('tls-ca.pem','/config/ca.pem'));
 if(config.mode==='tls') {
   delete result.services['control-ingress'].ports;delete result.services['app-ingress'].ports;
   result.services['tls-ingress']={...ingress,container_name:r.scope+'-tls-ingress',entrypoint:['nginx','-c','/etc/nginx/casimir.conf','-g','daemon off;'],ports:[`${config.bindAddress}:${config.controlPort}:8080`,`${config.bindAddress}:${config.appPort}:8081`],networks:['front'],volumes:[mount('tls.conf','/etc/nginx/casimir.conf'),mount('tls-cert.pem','/certs/cert.pem'),mount('tls-key.pem','/certs/key.pem')],depends_on:{'control-ingress':{condition:'service_started'},'app-ingress':{condition:'service_started'}},labels:label('tls-ingress')};
 }
 if(managementConfig)enableManagementConfig(result,state);
 if(identityEgress)enableIdentityEgressNetwork(result,installationId);
 return result;
}
async function privateFile(state,name,content,containerReader=false){const path=join(state,name);await writeFile(path,content,{mode:0o600});await chmod(path,0o600);if(containerReader&&process.getuid()===0)await chown(path,1000,1000);}
export async function install(state,config,bundleRoot){
 if(resolve(state)!==state||state===resolve(bundleRoot)||state.startsWith(resolve(bundleRoot)+'/')||resolve(bundleRoot).startsWith(state+'/'))throw new Error('state_bundle_paths_must_be_separate');
 return withStateLock(state,()=>installLocked(state,config,bundleRoot));
}
async function installLocked(state,config,bundleRoot){
 config=parseInstallConfig(config);const manifest=await verifyBundle(bundleRoot);
 if(config.mode!=='loopback')await validateCertificates(config);
 let existing;try{existing=JSON.parse(await readFile(join(state,'receipt.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!existing){const result=await preflight({stateParent:dirname(state),config,bundleBytes:manifest.files.reduce((n,f)=>n+f.bytes,0)});if(!result.ok)throw new Error(result.codes.join(','));}
 const bundleHash=createHash('sha256').update(await readFile(join(bundleRoot,'bundle.json'))).digest('hex');
 const images=Object.fromEntries(manifest.images.map(i=>[i.role,i.imageId]));
 const verifiedArchives=new Set();for(const image of manifest.images){const key=image.archive+':'+image.imageId;if(!verifiedArchives.has(key)){await verifyImageArchive(join(bundleRoot,image.archive),image.imageId);verifiedArchives.add(key);}}
 for(const image of manifest.images){let present=false;try{const i=JSON.parse(docker(['image','inspect',image.imageId]))[0];present=i.Id===image.imageId&&i.Os==='linux'&&i.Architecture==='amd64';}catch(error){if(error.code!=='not_found')throw error;} if(!present)docker(['load','--input',join(bundleRoot,image.archive)]);}
 const receipt=await initializeInstallation(state,config,{version:manifest.version,hash:bundleHash},async identity=>{
  await recordSourceRelease(state,await readFile(join(bundleRoot,'bundle.json'),'utf8'),bundleHash);
  const r=deriveResources(identity.installationId);
  for(const [kind,names] of [['volume',Object.values(r.volumes)],['network',[r.runtimeNetwork,r.appsNetwork,r.frontNetwork,deriveIdentityEgressNetwork(identity.installationId)]],['container',['db','init','migrate','management-state-preflight','api','executor','control-ingress','app-ingress','tls-ingress'].map(n=>r.scope+'-'+n)]])for(const name of names){let found;try{found=JSON.parse(docker([kind,'inspect',name]))[0];}catch(error){if(error.code!=='not_found')throw error;}if(found)assertOwnedResource(found,identity.installationId);}
  const databaseUrl=`postgresql://casimir:${identity.databasePassword}@${r.dbContainer}:5432/casimir`;
  await privateFile(state,'db.env',`POSTGRES_USER=casimir\nPOSTGRES_DB=casimir\nPOSTGRES_PASSWORD=${identity.databasePassword}\n`);
  await privateFile(state,'database.env',`DATABASE_URL=${databaseUrl}\n`);
  await privateFile(state,'api.env',`DATABASE_URL=${databaseUrl}\nCASIMIR_TOKEN=${identity.token}\nCASIMIR_OPERATOR_ID=initializing\nPORT=3000\n`);
  await privateFile(state,'profile.json',JSON.stringify({runtime:manifest.runtime,artifactRoot:'/artifacts',installationId:identity.installationId,origins:{control:config.controlOrigin,app:config.appOrigin},...(config.mode==='external-tls'?{externalTls:{controlPort:config.controlPort,appPort:config.appPort}}:{})}),true);
  await privateFile(state,'runner.json',JSON.stringify({runtime:manifest.runtime,imageId:images.runner}),true);
  await privateFile(state,'runtime-env.json',JSON.stringify({SERVER_ONLY:'synthetic-installation-'+identity.installationId}),true);
  const compose=renderCompose({installationId:identity.installationId,state,images,uid:process.getuid(),gid:process.getgid(),socketGid:(await stat('/var/run/docker.sock')).gid,config});
  compose.services.migrate.environment.CASIMIR_BUNDLE_VERSION=manifest.version;
  await privateFile(state,'compose.json',JSON.stringify(compose,null,2));
  await privateFile(state,'closed.conf','pid /tmp/nginx.pid; error_log /dev/stderr warn; events {} http { access_log off; client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; server { listen 8080; location / { return 503; } } }');
  if(process.getuid()===0)await chown(join(state,'closed.conf'),101,101);
  if(config.mode!=='loopback')await privateFile(state,'tls-ca.pem',await readFile(config.certificatePaths.ca),true);
  if(config.mode==='tls'){
    await privateFile(state,'tls.conf',tlsConfig(config,r.scope));await chown(join(state,'tls.conf'),101,101);
    for(const [source,name] of [[config.certificatePaths.certificate,'tls-cert.pem'],[config.certificatePaths.key,'tls-key.pem']]){
      await privateFile(state,name,await readFile(source));
      if(process.getuid()!==0)throw new Error('tls_private_key_install_requires_root_operator');
      await chown(join(state,name),101,101);
    }
  }
  await privateFile(state,'control.conf',`pid /tmp/nginx.pid; events {} http { access_log off; client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; server { listen 8080; client_max_body_size 65m; location / { proxy_pass http://${r.scope}-api:3000; proxy_set_header Host $http_host; } } }`,true);
  if(process.getuid()===0)await chown(join(state,"control.conf"),101,101);
  docker(['compose','-f',join(state,'compose.json'),'up','--wait','db']);
  docker(['compose','-f',join(state,'compose.json'),'run','--rm','-T','migrate']);
  const ids=JSON.parse(await readFile(join(state,'bootstrap-result.json'),'utf8'));
  await privateFile(state,'api.env',`DATABASE_URL=${databaseUrl}\nCASIMIR_TOKEN=${identity.token}\nCASIMIR_OPERATOR_ID=${ids.operatorId}\nPORT=3000\n`);
  return ids;
 },true);
 if(receipt.phase!=='ready')return {outcome:'blocked',code:receipt.phase,installationId:receipt.installationId,bundleVersion:receipt.bundleVersion};
 await runWithOwnedInstallResources(receipt.installationId,config,async()=>{
  const identity=await readPrivate(join(state,'identity.json'));
  const managementOwner=await prepareCasimirManagementOwner(state,identity,true);
  const composePath=join(state,'compose.json'),enrollmentResultPath=join(state,'management-enrollment-result.json');
  await rm(enrollmentResultPath,{force:true});
  docker(['compose','-f',composePath,'run','--rm','-T','-e','CASIMIR_MANAGEMENT_ENROLLMENT=true','-e','CASIMIR_BOOTSTRAP_RESULT=/state/management-enrollment-result.json','migrate']);
  const adopted=await readPrivate(enrollmentResultPath);
  if(adopted.operatorId!==managementOwner.operatorId||adopted.projectId!==managementOwner.projectId)throw new Error('management_enrollment_result_identity');
  await rm(enrollmentResultPath);
  await publishCasimirManagementConfig(state,managementOwner,true);
  const currentCompose=JSON.parse(await readFile(composePath,'utf8'));
  enableManagementConfig(currentCompose,state);
  await privateFile(state,'api.env',addManagementConfigToApiEnv(await readFile(join(state,'api.env'),'utf8')));
  await atomicPrivateJson(composePath,currentCompose);
 },docker);
 // Existing receipts must not bypass ownership validation on an idempotent retry.
 assertInstallResourcesOwned(receipt.installationId,config);
 docker(['compose','-f',join(state,'compose.json'),'up','-d','--wait','executor',config.mode==='tls'?'tls-ingress':'control-ingress','app-ingress']);
 const observation=JSON.parse(docker(['compose','-f',join(state,'compose.json'),'run','--rm','--no-deps','-T','operator']));
 if(observation.installationId!==receipt.installationId||observation.bundleVersion!==receipt.bundleVersion)throw new Error('readiness_identity');
 return observation;
}
