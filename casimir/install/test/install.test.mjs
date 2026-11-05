import {test} from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../install.mjs').catch(()=>({}));
test('installation_compose_has_fixed_scoped_recipes_no_test_failpoints_or_app_restart',()=>{
 assert.equal(typeof api.renderCompose,'function','install recipe missing');
 const id='1'.repeat(32),images=Object.fromEntries(['control','runner','lifecycle','database','ingress','tooling'].map(role=>[role,'sha256:'+'a'.repeat(64)]));
 const v=api.renderCompose({installationId:id,state:'/state with spaces',images,uid:1000,gid:1000,socketGid:999,config:{mode:'loopback',bindAddress:'127.0.0.1',controlPort:4485,appPort:4486}});
 assert.equal(v.services.db.container_name,`casimir-${id}-db`);assert.equal(v.services.executor.restart,'unless-stopped');assert.ok(!JSON.stringify(v).includes('FAILPOINT'));
 assert.deepEqual(v.services.api.command,['node','casimir/dist/main.mjs']);
 assert.equal(v.networks.front.internal,false);assert.equal(v.networks.apps.internal,true);assert.equal(v.networks.runtime.internal,true);
 assert.ok(!v.services.api.networks.includes('front'));assert.ok(!v.services.executor.networks.includes('front'));
 assert.deepEqual(v.services.operator.profiles,['operator']);assert.equal(v.services.operator.restart,undefined);assert.equal(v.services.operator.ports,undefined);assert.deepEqual(v.services.operator.command,['node','casimir/dist/lifecycle.mjs','status']);
 for(const [name,service] of Object.entries(v.services)) if(name!=='executor'&&name!=='operator') assert.ok(!JSON.stringify(service).includes('/var/run/docker.sock'));
 assert.ok(v.services.migrate.command.join(' ').includes('bootstrap-job.mjs'));assert.ok(!JSON.stringify(v).includes('seed.mjs'));
 assert.ok(Object.values(v.volumes).every(x=>x.labels['org.casimir.installation']===id));
});
test('management_config_mount_is_read_only_and_available_only_to_the_api',()=>{
 const id='2'.repeat(32),images=Object.fromEntries(['control','runner','lifecycle','database','ingress','tooling'].map(role=>[role,'sha256:'+'b'.repeat(64)]));
 const v=api.renderCompose({installationId:id,state:'/private/state',images,uid:0,gid:0,socketGid:999,config:{mode:'loopback',bindAddress:'127.0.0.1',controlPort:4485,appPort:4486},managementConfig:true});
 assert.ok(v.services.api.volumes.some(volume=>typeof volume==='object'&&volume.source==='/private/state/management.json'&&volume.target==='/config/management.json'&&volume.read_only===true));
 for(const [name,service]of Object.entries(v.services))if(name!=='api')assert.ok(!JSON.stringify(service).includes('management.json'),`${name} must not receive management keys`);
});
test('identity_egress_network_is_explicit_api_only_and_keeps_legacy_management_mounts_cli_only',()=>{
 const id='5'.repeat(32),images=Object.fromEntries(['control','runner','lifecycle','database','ingress','tooling'].map(role=>[role,'sha256:'+'c'.repeat(64)]));
 const config={mode:'loopback',bindAddress:'127.0.0.1',controlPort:4485,appPort:4486};
 const legacy=api.renderCompose({installationId:id,state:'/private/state',images,uid:0,gid:0,socketGid:999,config,managementConfig:true});
 assert.equal(legacy.networks['identity-egress'],undefined,'config-file presence must not activate identity egress');
 assert.ok(legacy.services.api.volumes.some(volume=>volume.target==='/config/management.json'),'legacy management file mount remains available');

 const managed=api.renderCompose({installationId:id,state:'/private/state',images,uid:0,gid:0,socketGid:999,config,managementConfig:true,identityEgress:true});
 const egress=managed.networks['identity-egress'];
 assert.ok(egress,'explicit management activation requires the identity egress network');
 assert.equal(egress.name,`casimir-${id}-identity-egress`);
 assert.equal(egress.internal,false);
 assert.equal(egress.labels['org.casimir.installation'],id);
 assert.ok(managed.services.api.networks.includes('identity-egress'));
 for(const [name,service] of Object.entries(managed.services))if(name!=='api')assert.ok(!(service.networks??[]).includes('identity-egress'),`${name} must not receive identity egress`);
 assert.equal(managed.services.api.ports,undefined,'identity egress must not publish API ports');
});
test('install_resource_ownership_scan_rejects_a_foreign_identity_egress_network',()=>{
 assert.equal(typeof api.assertInstallResourcesOwned,'function');
 const id='6'.repeat(32),foreign='f'.repeat(32),target=`casimir-${id}-identity-egress`,calls=[];
 const inspect=args=>{calls.push(args);return args[0]==='network'&&args[2]===target?JSON.stringify([{Labels:{'org.casimir.installation':foreign}}]):'[]';};
 assert.throws(()=>api.assertInstallResourcesOwned(id,{mode:'loopback'},inspect),/foreign_resource_refused/);
 assert.ok(calls.some(args=>args[0]==='network'&&args[2]===target),'optional network slot must be inspected even for legacy installs');
});
test('management_api_env_is_added_idempotently_without_rewriting_other_values',()=>{
 assert.equal(typeof api.addManagementConfigToApiEnv,'function','API env update helper missing');
 if(typeof api.addManagementConfigToApiEnv!=='function')return;
 assert.equal(api.addManagementConfigToApiEnv('PORT=3000\nCASIMIR_TOKEN=synthetic\n'),'PORT=3000\nCASIMIR_TOKEN=synthetic\nCASIMIR_MANAGEMENT_CONFIG=/config/management.json\n');
 assert.equal(api.addManagementConfigToApiEnv('PORT=3000\nCASIMIR_MANAGEMENT_CONFIG=/config/management.json\n'),'PORT=3000\nCASIMIR_MANAGEMENT_CONFIG=/config/management.json\n');
 assert.throws(()=>api.addManagementConfigToApiEnv('CASIMIR_MANAGEMENT_CONFIG=/wrong\n'),/management_api_environment/);
});
test('management enrollment is refused before its callback when an install resource is foreign',async()=>{
 assert.equal(typeof api.runWithOwnedInstallResources,'function','ownership-gated enrollment helper missing');
 let enrollmentStarted=false;
 const inspect=()=>JSON.stringify([{Config:{Labels:{'org.casimir.installation':'f'.repeat(32)}}}]);
 await assert.rejects(()=>api.runWithOwnedInstallResources('3'.repeat(32),{mode:'loopback'},async()=>{enrollmentStarted=true;},inspect),/foreign_resource_refused/);
 assert.equal(enrollmentStarted,false);
});
test('management enrollment callback starts only after all install resources are inspected',async()=>{
 const events=[];
 const inspect=(args)=>{events.push(args);return '[]';};
 const result=await api.runWithOwnedInstallResources('4'.repeat(32),{mode:'loopback'},async()=>{events.push('enrollment');return 'enrolled';},inspect);
 assert.equal(result,'enrolled');
 assert.equal(events.at(-1),'enrollment');
 assert.ok(events.length>1);
 assert.ok(events.slice(0,-1).every(Array.isArray));
});
test('private_state_inside_distribution_is_refused_before_files_or_docker',async()=>{
 await assert.rejects(()=>api.install('/tmp/bundle/state',{},'/tmp/bundle'),/state_bundle_paths_must_be_separate/);
 await assert.rejects(()=>api.install('/tmp/state',{},'/tmp/state/bundle'),/state_bundle_paths_must_be_separate/);
});
