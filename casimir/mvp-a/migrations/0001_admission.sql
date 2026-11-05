CREATE TABLE casimir_mvp_a.scope (
 id integer PRIMARY KEY CHECK (id=1), project_id text REFERENCES public.projects(id) ON DELETE RESTRICT
);
INSERT INTO casimir_mvp_a.scope(id) VALUES(1);
CREATE TABLE casimir_mvp_a.uploads (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 bytes bigint NOT NULL CHECK (bytes>0 AND bytes<=67108864), sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'staging' CHECK(state IN ('staging','receiving','uploaded','finalized','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE TABLE casimir_mvp_a.artifacts (
 id text PRIMARY KEY, upload_id text NOT NULL UNIQUE REFERENCES casimir_mvp_a.uploads(id),
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 path text NOT NULL UNIQUE, bytes bigint NOT NULL, sha256 text NOT NULL,
 manifest jsonb NOT NULL, runtime jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE casimir_mvp_a.operations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 artifact_id text NOT NULL REFERENCES casimir_mvp_a.artifacts(id) ON DELETE RESTRICT,
 deployment_id text NOT NULL UNIQUE REFERENCES public.deployments(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL, input_hash text NOT NULL,
 phase text NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','preparing','preflighting','maintenance','migrating','verifying','exposure_started','succeeded','compensating','failed','recovery_required')),
 outcome text, runtime jsonb NOT NULL, image_id text, secret_revision text, previous_target jsonb,
 migration_fingerprint text, snapshot_fingerprint text, candidate_id text, job_id text,
 compatibility_proof jsonb, exposure_started timestamptz, observation jsonb, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,actor_id,idempotency_key)
);
CREATE UNIQUE INDEX mvp_one_blocking_project ON casimir_mvp_a.operations(project_id) WHERE phase NOT IN ('succeeded','failed');
CREATE TABLE casimir_mvp_a.preparations (
 id text PRIMARY KEY, operation_id text NOT NULL UNIQUE REFERENCES casimir_mvp_a.operations(id),
 state text NOT NULL, image_id text, job_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE casimir_mvp_a.executor_guard (
 scope text PRIMARY KEY, container_id text NOT NULL, started_at text NOT NULL, instance text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
