import type { InstallResources } from './types.ts';
export function deriveResources(id: string): InstallResources {
  if(!/^[a-f0-9]{32}$/.test(id)) throw new Error('installation_identity_invalid');
  const scope=`casimir-${id}`;
  return {scope,dbContainer:`${scope}-db`,executorContainer:`${scope}-executor`,appIngressContainer:`${scope}-app-ingress`,runtimeNetwork:`${scope}-runtime`,appsNetwork:`${scope}-apps`,frontNetwork:`${scope}-front`,volumes:{database:`${scope}-database`,artifacts:`${scope}-artifacts`,appdata:`${scope}-appdata`,snapshots:`${scope}-snapshots`,routes:`${scope}-routes`,runtimeSecrets:`${scope}-runtime-secrets`,jobs:`${scope}-jobs`}};
}
/** Deterministic optional network slot for the API's trusted identity-provider egress. */
export function deriveIdentityEgressNetwork(id: string): string {
  return `${deriveResources(id).scope}-identity-egress`;
}
export function assertOwnedResource(resource: {Labels?: Record<string,string>; Config?: {Labels?: Record<string,string>}}, id: string): void {
  deriveResources(id);
  if((resource.Config?.Labels ?? resource.Labels)?.['org.casimir.installation']!==id) throw new Error('foreign_resource_refused');
}
