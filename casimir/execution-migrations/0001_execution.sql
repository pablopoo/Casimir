CREATE TABLE casimir.execution_scope (
  id integer PRIMARY KEY CHECK (id = 1),
  project_id text REFERENCES projects(id) ON DELETE RESTRICT
);
INSERT INTO casimir.execution_scope(id) VALUES (1);
CREATE TABLE casimir.execution_operations (
  id text PRIMARY KEY CHECK (id ~ '^cex_[a-z0-9]{12}$'),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  deployment_id text NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[ -~]{1,128}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  image_alias text NOT NULL CHECK (image_alias IN ('demo-v1','demo-v2','demo-broken')),
  image_id text NOT NULL CHECK (image_id ~ '^sha256:[a-f0-9]{64}$'),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL DEFAULT 'queued' CHECK (phase IN ('queued','preflighting','cutover','verifying','compensating','recovery_required','succeeded','failed')),
  outcome text CHECK (outcome IN ('activated','rejected','restored','unavailable')),
  previous_target jsonb,
  candidate_id text,
  executor_instance text,
  route_identity jsonb,
  last_observation jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,actor_id,idempotency_key),
  CHECK ((phase IN ('succeeded','failed')) = (outcome IS NOT NULL)),
  CHECK (phase <> 'succeeded' OR outcome = 'activated'),
  CHECK (phase <> 'failed' OR outcome <> 'activated')
);
CREATE UNIQUE INDEX execution_one_blocking_project ON casimir.execution_operations(project_id)
  WHERE phase NOT IN ('succeeded','failed');
CREATE TABLE casimir.executor_guard (
  scope text PRIMARY KEY CHECK (scope = 'casimir-execution-poc'),
  container_id text NOT NULL,
  started_at text NOT NULL,
  instance text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
