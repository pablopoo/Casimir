UPDATE "projects" SET "mode" = 'void' WHERE "mode" = 'worker';
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "mode" SET DEFAULT 'void';
