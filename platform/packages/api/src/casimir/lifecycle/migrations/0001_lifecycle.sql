CREATE TABLE casimir_install.installation (
 id integer PRIMARY KEY CHECK (id=1),
 installation_id text NOT NULL UNIQUE CHECK (installation_id ~ '^[a-f0-9]{32}$'),
 operator_id text NOT NULL REFERENCES users(id),
 project_id text NOT NULL REFERENCES projects(id),
 bundle_version text NOT NULL,
 phase text NOT NULL CHECK (phase IN ('ready','stopped','maintenance','recovery_required')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE casimir_install.maintenance (
 id text PRIMARY KEY,
 installation_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('backup','restore','upgrade','stop')),
 phase text NOT NULL,
 source_version text NOT NULL,
 target_version text,
 inventory_hash text,
 last_error_code text,
 detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
