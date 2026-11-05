import type { CasimirManifest, RuntimeDescriptor } from '@void/deploy-core';
export type MvpProfile = Readonly<{ runtime: RuntimeDescriptor; artifactRoot: string; installationId?: string; externalTls?: {controlPort:number;appPort:number}; origins?: {control: string; app: string} }>;
export const MVP_PHASES = [
  'queued',
  'preparing',
  'preflighting',
  'maintenance',
  'migrating',
  'verifying',
  'exposure_started',
  'succeeded',
  'compensating',
  'failed',
  'recovery_required',
] as const;
export type MvpPhase = (typeof MVP_PHASES)[number];
export type MvpOperation = Readonly<{
  id: string;
  project_id: string;
  actor_id: string;
  artifact_id: string;
  deployment_id: string;
  idempotency_key: string;
  input_hash: string;
  phase: MvpPhase;
  outcome: string | null;
  runtime: RuntimeDescriptor;
  image_id: string | null;
  secret_revision: string | null;
  previous_target: Record<string, unknown> | null;
  migration_fingerprint: string | null;
  snapshot_fingerprint: string | null;
  candidate_id: string | null;
  job_id: string | null;
  compatibility_proof: Record<string, unknown> | null;
  exposure_started: Date | null;
  observation: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}>;
export type MvpArtifact = Readonly<{
  id: string;
  upload_id: string;
  project_id: string;
  actor_id: string;
  path: string;
  bytes: string;
  sha256: string;
  manifest: CasimirManifest;
  runtime: RuntimeDescriptor;
}>;
export type Receipt = Readonly<{ operationId: string; deploymentId: string }>;
export type OperationView = Readonly<{
  operationId: string;
  phase: MvpPhase;
  outcome: string | null;
  desired: { deploymentId: string; artifactId: string; imageId: string | null };
  verifiedServing: Record<string, unknown> | null;
  error: string | null;
}>;
