CREATE TABLE "deployment_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"build_id" text,
	"original_active_id" text,
	"cli_version" text,
	"idempotency_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_prefix" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"owner_id" text,
	"lease_expires_at" timestamp,
	"next_dispatch_at" timestamp DEFAULT now() NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"inputs_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deployment_operations_key" ON "deployment_operations" USING btree ("project_id","actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_deployment_operations_dispatch" ON "deployment_operations" USING btree ("status","next_dispatch_at");