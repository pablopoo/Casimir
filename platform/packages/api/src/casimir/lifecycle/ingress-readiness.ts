import {request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {checkServerIdentity} from 'node:tls';
import type {MvpEngine} from '../mvp/engine.ts';
export async function inspectIngressPublication(engine:Pick<MvpEngine,'scope'|'inspectContainer'>,origins:{control:string;app:string},ca?:Buffer,externalTls?:{controlPort:number;appPort:number}){
 const observations:Record<string,{status:number;headers:IncomingHttpHeaders}>={};
 for(const role of ['control','app'] as const){
  const origin=new URL(origins[role]),tls=origin.protocol==='https:',port=tls?(role==='control'?8080:8081):8080;
  const container=await engine.inspectContainer(engine.scope+'-'+(tls&&!externalTls?'tls':role)+'-ingress');
  const published=container?.NetworkSettings.Ports?.[(externalTls?8080:port)+'/tcp'];
  if(externalTls){
   if(!tls||!container?.State.Running||!published?.length||published.some(p=>!['127.0.0.1','::1'].includes(p.HostIp)||p.HostPort!==String(externalTls[role+'Port' as 'controlPort'|'appPort'])))throw new Error('external_tls_backend_not_loopback');
  }else if(!container?.State.Running||!published?.some(p=>p.HostPort===(origin.port||(tls?'443':'80'))))throw new Error('ingress_listener_unpublished');
  const address=container?.NetworkSettings.Networks[engine.scope+'-front']?.IPAddress;
  if((!externalTls&&!address)||(tls&&!ca))throw new Error('ingress_certificate_or_network_missing');
  const observation=await new Promise<{status:number;headers:IncomingHttpHeaders}>((resolve,reject)=>{
   // Connect directly to the inspected ingress IP. Keep the public origin for
   // HTTP Host and TLS identity; IP literals use the certificate SAN without
   // sending an IP-valued SNI name.
   const req=(tls?httpsRequest:httpRequest)({hostname:externalTls?origin.hostname:address!,port:externalTls?Number(origin.port||443):port,path:role==='control'?'/health':'/',method:'GET',family:4,headers:{Host:origin.host,Connection:'close'},...(tls?{ca,...(isIP(origin.hostname)===0?{servername:origin.hostname}:{}),checkServerIdentity:(_hostname,certificate)=>checkServerIdentity(origin.hostname,certificate),rejectUnauthorized:true}:{}),timeout:3000},res=>{const result={status:res.statusCode??0,headers:res.headers};res.destroy();resolve(result);});
   req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('ingress_probe_timeout')));req.end();
  });
  if(role==='control'&&observation.status!==200)throw new Error('control_ingress_unhealthy');
  observations[role]=observation;
 }
 return observations;
}

export type ControlIngressRequestTarget = Readonly<{
 hostname: string;
 port: number;
 host: string;
 servername: string;
 externalTls: boolean;
}>;

/** Resolve the one owned HTTPS control ingress target used by the signed setup POST. */
export async function inspectControlIngressRequestTarget(
 engine:Pick<MvpEngine,'scope'|'inspectContainer'>,
 controlOrigin:string,
 ca:Buffer,
 externalTls?:{controlPort:number;appPort:number},
):Promise<ControlIngressRequestTarget>{
 const origin=new URL(controlOrigin);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||!ca.length)throw new Error('auth_setup_ingress_invalid');
 const installationId=engine.scope.startsWith('casimir-')?engine.scope.slice('casimir-'.length):'';
 if(!/^[a-f0-9]{32}$/.test(installationId))throw new Error('auth_setup_ingress_invalid');
 const container=await engine.inspectContainer(engine.scope+(externalTls?'-control-ingress':'-tls-ingress'));
 if(!container?.State?.Running||container.Config?.Labels?.['org.casimir.installation']!==installationId)throw new Error('auth_setup_ingress_unowned');
 const expectedPort=origin.port||'443';
 if(externalTls){
  const published=container.NetworkSettings.Ports?.['8080/tcp'];
  if(!Number.isInteger(externalTls.controlPort)||externalTls.controlPort<1||externalTls.controlPort>65535||!published?.length||published.some(p=>!['127.0.0.1','::1'].includes(p.HostIp)||p.HostPort!==String(externalTls.controlPort)))throw new Error('auth_setup_ingress_unpublished');
  return {hostname:origin.hostname.replace(/^\[|\]$/g,''),port:Number(expectedPort),host:origin.host,servername:origin.hostname.replace(/^\[|\]$/g,''),externalTls:true};
 }
 const published=container.NetworkSettings.Ports?.['8080/tcp'];
 const address=container.NetworkSettings.Networks?.[engine.scope+'-front']?.IPAddress;
 if(!published?.some(p=>p.HostPort===expectedPort)||!address||isIP(address)===0)throw new Error('auth_setup_ingress_unpublished');
 return {hostname:address,port:8080,host:origin.host,servername:origin.hostname.replace(/^\[|\]$/g,''),externalTls:false};
}
