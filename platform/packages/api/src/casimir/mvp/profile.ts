import { readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { parseRuntimeDescriptor } from '@void/deploy-core';
import type { MvpProfile } from './types.ts';
import { deriveResources } from '../lifecycle/resources.ts';
export function loadMvpProfile(file: string): MvpProfile {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== (value.installationId === undefined ? 'artifactRoot,runtime' : value.externalTls ? 'artifactRoot,externalTls,installationId,origins,runtime' : 'artifactRoot,installationId,origins,runtime') ||
    typeof value.artifactRoot !== 'string' ||
    !isAbsolute(value.artifactRoot) ||
    value.artifactRoot.includes('\0') ||
    normalize(value.artifactRoot) !== value.artifactRoot
  ) {
    throw new Error('invalid MVP profile');
  }
  if (value.installationId !== undefined) deriveResources(value.installationId);
  if(value.externalTls && (Object.keys(value.externalTls).sort().join(',')!=='appPort,controlPort'||!Object.values(value.externalTls).every(p=>Number.isInteger(p)&&Number(p)>0&&Number(p)<=65535)||value.externalTls.controlPort===value.externalTls.appPort))throw new Error('external_tls_profile_invalid');
  if (value.installationId !== undefined && (!value.origins || Object.keys(value.origins).sort().join(',') !== 'app,control' || Object.values(value.origins).some(origin => typeof origin !== 'string' || new URL(origin).origin !== origin || !['http:','https:'].includes(new URL(origin).protocol)))) throw new Error('installation_origins_invalid');
  return Object.freeze({
    runtime: parseRuntimeDescriptor(value.runtime),
    artifactRoot: value.artifactRoot,
    ...(value.installationId === undefined ? {} : {installationId: value.installationId}),
    ...(value.origins === undefined ? {} : {origins: value.origins}),
    ...(value.externalTls === undefined ? {} : {externalTls: value.externalTls}),
  });
}
