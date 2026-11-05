import type { RuntimeDescriptor } from '@void/deploy-core';
export type BundleManifest = {
  format: 1; version: string; sourceRevision: string; platform: 'linux/amd64'; runtime: RuntimeDescriptor;
  images: Array<{role: string; archive: string; sha256: string; imageId: string;repoDigests:string[]}>;
  sdk: Array<{path: string; sha256: string}>;
  files: Array<{path: string; bytes: number; sha256: string}>;
  controlSchema: {version: number; migrationHashes: string[]; readableBy: string[]}; upgradeFrom: string[];
};
export type InstallConfig = {format: 1; mode: 'loopback'|'tls'|'external-tls'; controlOrigin: string; appOrigin: string; bindAddress: string; controlPort: number; appPort: number; certificatePaths?: {certificate?: string; key?: string; ca: string}};
export type InstallResources = {scope: string; dbContainer: string; executorContainer: string; appIngressContainer: string; runtimeNetwork: string; appsNetwork: string; frontNetwork: string; volumes: {database: string; artifacts: string; appdata: string; snapshots: string; routes: string; runtimeSecrets: string; jobs: string}};
export type InstallReceipt = {format: 1; installationId: string; bundleVersion: string; bundleHash: string; operatorId: string; projectId: string; phase: 'initializing'|'ready'|'stopped'|'maintenance'|'recovery_required'; resources: InstallResources};
export type MaintenanceRecord = {id: string; installationId: string; kind: 'backup'|'restore'|'upgrade'|'stop'; phase: string; sourceVersion: string; targetVersion?: string; inventoryHash?: string; lastErrorCode?: string};
export type LifecycleResult = {outcome: 'ready'|'stopped'|'blocked'; code: string; installationId: string; operationId?: string; bundleVersion: string; servingObservation?: {project: string; deployment: string; imageId: string; observedAt: string}};
