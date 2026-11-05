import { isIP } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import type { InstallConfig } from './types.ts';
const loopback=(s: string)=>s==='127.0.0.1' || s==='::1';
export function parseInstallConfig(value: unknown): InstallConfig {
  const v=value as InstallConfig;
  const keys='appOrigin,appPort,bindAddress,controlOrigin,controlPort,format,mode'+(v?.certificatePaths?',certificatePaths':'');
  if(!v || typeof v!=='object' || Object.keys(v).sort().join(',')!==keys.split(',').sort().join(',') || v.format!==1 || !['loopback','tls','external-tls'].includes(v.mode) || !isIP(v.bindAddress) || ![v.controlPort,v.appPort].every(p=>Number.isInteger(p)&&p>0&&p<=65535) || v.controlPort===v.appPort) throw new Error('install_config_invalid');
  const origins=[v.controlOrigin,v.appOrigin].map(s=>{const u=new URL(s);if(u.origin!==s || u.username || u.password) throw new Error('origin_invalid');return u;});
  if(v.controlOrigin===v.appOrigin) throw new Error('origins_must_differ');
  if(v.mode==='loopback') {
    if(v.certificatePaths || !loopback(v.bindAddress) || origins.some(u=>u.protocol!=='http:' || !loopback(u.hostname.replace(/^\[|\]$/g,''))) || Number(origins[0].port||80)!==v.controlPort || Number(origins[1].port||80)!==v.appPort) throw new Error('loopback_only');
  } else {
    if(origins.some(u=>u.protocol!=='https:') || !v.certificatePaths || Object.keys(v.certificatePaths).sort().join(',')!==(v.mode==='external-tls'?'ca':'ca,certificate,key') || Object.values(v.certificatePaths).some(p=>typeof p!=='string'||!isAbsolute(p)||normalize(p)!==p||/[\0\r\n]/.test(p))) throw new Error('tls_config_invalid');
    if(v.mode==='external-tls' && !loopback(v.bindAddress)) throw new Error('external_tls_requires_loopback_backend');
    if(v.mode==='tls' && (Number(origins[0].port||443)!==v.controlPort || Number(origins[1].port||443)!==v.appPort)) throw new Error('tls_port_mismatch');
  }
  return v;
}
