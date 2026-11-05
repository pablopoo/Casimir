export type Phase =
  | 'queued'
  | 'preflighting'
  | 'cutover'
  | 'verifying'
  | 'compensating'
  | 'recovery_required'
  | 'succeeded'
  | 'failed';
export type Outcome = 'activated' | 'rejected' | 'restored' | 'unavailable';
export type ImageId = `sha256:${string}`;
export type ImageAlias = 'demo-v1' | 'demo-v2' | 'demo-broken';
export interface ExecutionProfile {
  recipeVersion: 1;
  scope: 'casimir-execution-poc';
  controlPort: 4283;
  appPort: 4284;
  images: Record<ImageAlias, ImageId>;
  fingerprint: string;
}
export interface Target {
  projectId: string;
  deploymentId: string;
  containerId: string;
  imageId: ImageId;
  version: string;
}
export interface RouteIdentity {
  target: Target | null;
  fingerprint: string;
  observedAt: string;
}
export interface Observation {
  target: Target | null;
  route: RouteIdentity;
  healthy: boolean;
  writable: boolean;
  loopbackVerified: boolean;
  observedAt: string;
}
export type Operation = {
  id: string;
  project_id: string;
  deployment_id: string;
  actor_id: string;
  idempotency_key: string;
  input_hash: string;
  image_alias: ImageAlias;
  image_id: ImageId;
  profile_hash: string;
  phase: Phase;
  outcome: Outcome | null;
  previous_target: Target | null;
  candidate_id: string | null;
  executor_instance: string | null;
  route_identity: RouteIdentity | null;
  last_observation: Observation | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};
