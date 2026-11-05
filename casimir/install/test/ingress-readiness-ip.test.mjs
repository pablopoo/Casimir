import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {inspectIngressPublication} from '../../../platform/packages/api/src/casimir/lifecycle/ingress-readiness.ts';

const scope='casimir-readiness-test';
let fixtures;

function openssl(args){execFileSync('openssl',args,{stdio:'ignore'});}

async function createAuthority(directory,name){
 const key=join(directory,`${name}.key`),certificate=join(directory,`${name}.crt`);
 openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','1','-subj',`/CN=${name}`,'-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
 return {key,certificate,bytes:await readFile(certificate)};
}

async function issueServerCertificate(directory,name,authority,san){
 const key=join(directory,`${name}.key`),csr=join(directory,`${name}.csr`),certificate=join(directory,`${name}.crt`),extensions=join(directory,`${name}.ext`);
 await writeFile(extensions,`[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
 openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj',`/CN=${name}`]);
 openssl(['x509','-req','-in',csr,'-CA',authority.certificate,'-CAkey',authority.key,'-CAcreateserial','-out',certificate,'-days','1','-sha256','-extfile',extensions,'-extensions','server']);
 return {key:await readFile(key),cert:await readFile(certificate)};
}

function engineFor({tls,addresses={control:'127.0.0.1',app:'127.0.0.3'},backendHost='127.0.0.1',backendPorts}={}){
 return {
  scope,
  async inspectContainer(name){
   const role=name===`${scope}-control-ingress`?'control':'app';
   const ports=backendPorts??(tls?{'8080/tcp':[{HostIp:'127.0.0.2',HostPort:'4485'}],'8081/tcp':[{HostIp:'127.0.0.4',HostPort:'4486'}]}:{'8080/tcp':[{HostIp:'127.0.0.2',HostPort:role==='control'?'4485':'4486'}]});
   const ip=tls&&!name.endsWith('-control-ingress')&&!name.endsWith('-app-ingress')?backendHost:tls?backendHost:addresses[role];
   return {State:{Running:true},NetworkSettings:{Ports:ports,Networks:{[`${scope}-front`]:{IPAddress:ip}}}};
  },
 };
}

test('configured host bindings without published ports are still rejected',async()=>{
 const engine={
  scope,
  async inspectContainer(){return {State:{Running:true},HostConfig:{PortBindings:{'8080/tcp':[{HostPort:'4485'}]}},NetworkSettings:{Ports:{'8080/tcp':null},Networks:{}}};},
 };
 await assert.rejects(
  ()=>inspectIngressPublication(engine,{control:'https://control.test:4485',app:'https://app.test:4486'},Buffer.from('fixture')),
  /ingress_listener_unpublished/,
 );
});

function responseHandler(seen,role,status){
 return (request,response)=>{
  seen.push({role,host:request.headers.host,servername:request.socket.servername||null});
  response.statusCode=status;
  response.end('probe');
 };
}

function start(server,address,port){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,address,()=>{server.removeListener('error',reject);resolve();});
 });
}

async function withServers(entries,run){
 const started=[];
 try{
  for(const entry of entries){await start(entry.server,entry.address,entry.port);started.push(entry.server);}
  return await run();
 }finally{
  await Promise.all(started.map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));
 }
}

function httpPair(seen){
 return [
  {server:createHttpServer(responseHandler(seen,'control',200)),address:'127.0.0.1',port:8080},
  {server:createHttpServer(responseHandler(seen,'app',503)),address:'127.0.0.3',port:8080},
 ];
}

function tlsPair(credentials,seen){
 const control=createHttpsServer(credentials,responseHandler(seen,'control',200));
 const app=createHttpsServer(credentials,responseHandler(seen,'app',503));
 for(const server of [control,app])server.on('tlsClientError',()=>{});
 return [
  {server:control,address:'127.0.0.1',port:8080},
  {server:app,address:'127.0.0.1',port:8081},
 ];
}

before(async()=>{
 const directory=await mkdtemp(join(tmpdir(),'casimir-ingress-readiness-'));
 const trusted=await createAuthority(directory,'trusted-ca');
 const untrusted=await createAuthority(directory,'untrusted-ca');
 fixtures={
  directory,
  trusted,
  valid:await issueServerCertificate(directory,'valid-server',trusted,'DNS:control.test,DNS:app.test,IP:127.0.0.2,IP:127.0.0.4'),
  wrongSan:await issueServerCertificate(directory,'wrong-san-server',trusted,'DNS:wrong.test'),
  wrongIpSan:await issueServerCertificate(directory,'wrong-ip-san-server',trusted,'IP:127.0.0.99'),
  untrusted:await issueServerCertificate(directory,'untrusted-server',untrusted,'DNS:control.test'),
 };
});

after(async()=>{if(fixtures)await rm(fixtures.directory,{recursive:true,force:true});});

test('HTTP IPv4 origins connect to inspected ingress addresses and preserve public Host headers',async()=>{
 const seen=[];
 await withServers(httpPair(seen),async()=>{
  const result=await inspectIngressPublication(engineFor({tls:false}),{control:'http://127.0.0.2:4485',app:'http://127.0.0.4:4486'});
  assert.equal(result.control.status,200);
  assert.equal(result.app.status,503);
  assert.deepEqual(seen,[
   {role:'control',host:'127.0.0.2:4485',servername:null},
   {role:'app',host:'127.0.0.4:4486',servername:null},
  ]);
 });
});

test('HTTPS IPv4 origins use the public IP SAN without sending IP-valued SNI',async()=>{
 const seen=[];
 await withServers(tlsPair(fixtures.valid,seen),async()=>{
  const result=await inspectIngressPublication(engineFor({tls:true}),{control:'https://127.0.0.2:4485',app:'https://127.0.0.4:4486'},fixtures.trusted.bytes);
  assert.equal(result.control.status,200);
  assert.equal(result.app.status,503);
  assert.deepEqual(seen,[
   {role:'control',host:'127.0.0.2:4485',servername:null},
   {role:'app',host:'127.0.0.4:4486',servername:null},
  ]);
 });
});

test('HTTPS DNS origins preserve DNS SNI and the configured Host header',async()=>{
 const seen=[];
 await withServers(tlsPair(fixtures.valid,seen),async()=>{
  const result=await inspectIngressPublication(engineFor({tls:true}),{control:'https://control.test:4485',app:'https://app.test:4486'},fixtures.trusted.bytes);
  assert.equal(result.control.status,200);
  assert.equal(result.app.status,503);
  assert.deepEqual(seen,[
   {role:'control',host:'control.test:4485',servername:'control.test'},
   {role:'app',host:'app.test:4486',servername:'app.test'},
  ]);
 });
});

test('HTTPS DNS origins reject a certificate signed by the trusted CA for the wrong SAN',async()=>{
 const seen=[];
 await withServers(tlsPair(fixtures.wrongSan,seen),async()=>{
  await assert.rejects(
   ()=>inspectIngressPublication(engineFor({tls:true}),{control:'https://control.test:4485',app:'https://app.test:4486'},fixtures.trusted.bytes),
   error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID',
  );
  assert.equal(seen.length,0);
 });
});

test('HTTPS IPv4 origins reject a trusted certificate with the wrong IP SAN',async()=>{
 const seen=[];
 await withServers(tlsPair(fixtures.wrongIpSan,seen),async()=>{
  await assert.rejects(
   ()=>inspectIngressPublication(engineFor({tls:true}),{control:'https://127.0.0.2:4485',app:'https://127.0.0.4:4486'},fixtures.trusted.bytes),
   error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID',
  );
  assert.equal(seen.length,0);
 });
});

test('HTTPS DNS origins reject a matching SAN signed by an untrusted CA',async()=>{
 const seen=[];
 await withServers(tlsPair(fixtures.untrusted,seen),async()=>{
  await assert.rejects(
   ()=>inspectIngressPublication(engineFor({tls:true}),{control:'https://control.test:4485',app:'https://app.test:4486'},fixtures.trusted.bytes),
   error=>['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code),
  );
  assert.equal(seen.length,0);
 });
});

test('external TLS still rejects a publicly bound backend listener',async()=>{
 const engine=engineFor({tls:true,backendPorts:{'8080/tcp':[{HostIp:'0.0.0.0',HostPort:'4495'}]}});
 await assert.rejects(
  ()=>inspectIngressPublication(engine,{control:'https://control.external.test:4485',app:'https://app.external.test:4486'},fixtures.trusted.bytes,{controlPort:4495,appPort:4496}),
  /external_tls_backend_not_loopback/,
 );
});
