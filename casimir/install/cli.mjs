import {readFile} from 'node:fs/promises';
import {install} from './install.mjs';
import {verifyBundle} from './bundle.mjs';
import {operate} from './operate.mjs';
import {backup} from './backup.mjs';
import {upgrade} from './upgrade.mjs';
import {restore} from './restore.mjs';
import {planCleanup,uninstall} from './cleanup.mjs';
import {parseAuthSetupArguments} from './auth-setup-arguments.mjs';
const [command,...args]=process.argv.slice(2);
try {
 if(command==='verify'&&args.length===1){const m=await verifyBundle(args[0]);console.log(JSON.stringify({verified:true,version:m.version}));}
 else if(command==='install'&&args.length===3){console.log(JSON.stringify(await install(args[0],JSON.parse(await readFile(args[1],'utf8')),args[2])));}
 else if(command==='auth-setup'){
  const input=parseAuthSetupArguments(args);
  if(input.help){console.log('Usage: casimir auth-setup --state /absolute/private-state [--auth-config /private/auth.json --auth-secrets /private/secrets.json [--identity-policy /private/identity-policy.json]]');}
  else {
   const {authSetup}=await import('../dist/authSetup.mjs');
   const result=await authSetup(input.state,input);
   console.log(JSON.stringify(result.status==='pending'?{status:result.status,setupUrl:result.setupUrl,expiresAt:result.expiresAt,authBootstrapCode:result.authBootstrapCode}:{status:result.status}));
  }
 }
 else if(['status','stop','start'].includes(command)&&args.length===1){console.log(JSON.stringify(await operate(args[0],command)));}
 else if(command==='backup'&&args.length===3){console.log(JSON.stringify(await backup(args[0],args[1],args[2])));}
 else if(command==='upgrade'&&args.length===3){console.log(JSON.stringify(await upgrade(args[0],args[1],args[2])));}
 else if(command==='restore'&&args.length===4){console.log(JSON.stringify(await restore(args[0],args[1],args[2],args[3])));}
 else if(command==='retention'&&args.length===1){console.log(JSON.stringify(await planCleanup(args[0])));}
 else if(command==='uninstall'&&args.length===1){console.log(JSON.stringify(await uninstall(args[0])));}
 else throw new Error('unsupported_lifecycle_command');
}catch(error){
 if(command==='auth-setup'&&(error?.code==='auth_setup_usage'||error?.message==='auth_setup_usage')){
  console.error('Usage: casimir auth-setup --state /absolute/private-state [--auth-config /private/auth.json --auth-secrets /private/secrets.json [--identity-policy /private/identity-policy.json]]');
  process.exitCode=2;
 }else{console.error(error?.code||error?.message||'command_failed');process.exitCode=1;}
}
