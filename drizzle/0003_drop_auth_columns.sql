-- Rows written by a pre-Accounts server between 0002 and 0003: copy any ids not yet moved.
UPDATE "gateway" SET "owner_sub" = COALESCE("owner_sub", "owner_user_id"), "owner_club_id" = COALESCE("owner_club_id", "owner_org_id");--> statement-breakpoint
UPDATE "watcher" SET "owner_sub" = "user_id" WHERE "owner_sub" IS NULL;--> statement-breakpoint
UPDATE "abuse_report" SET "reporter_sub" = "reporter_user_id" WHERE "reporter_sub" IS NULL;--> statement-breakpoint
UPDATE "audit_log" SET "actor_sub" = "actor_user_id" WHERE "actor_sub" IS NULL;--> statement-breakpoint
UPDATE "site_setting" SET "updated_by_sub" = "updated_by" WHERE "updated_by_sub" IS NULL;--> statement-breakpoint
UPDATE "callsign_optout" SET "created_by_sub" = "created_by" WHERE "created_by_sub" IS NULL;--> statement-breakpoint
ALTER TABLE "device_link" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "device_link" CASCADE;--> statement-breakpoint
ALTER TABLE "abuse_report" DROP CONSTRAINT IF EXISTS "abuse_report_reporter_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actor_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "callsign_optout" DROP CONSTRAINT IF EXISTS "callsign_optout_created_by_fkey";
--> statement-breakpoint
ALTER TABLE "gateway" DROP CONSTRAINT IF EXISTS "gateway_owner_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "gateway" DROP CONSTRAINT IF EXISTS "gateway_owner_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "site_setting" DROP CONSTRAINT IF EXISTS "site_setting_updated_by_fkey";
--> statement-breakpoint
ALTER TABLE "watcher" DROP CONSTRAINT IF EXISTS "watcher_user_id_fkey";
--> statement-breakpoint
DROP INDEX "gateway_owner";--> statement-breakpoint
DROP INDEX "gateway_owner_org";--> statement-breakpoint
DROP INDEX "watcher_user";--> statement-breakpoint
ALTER TABLE "watcher" ALTER COLUMN "owner_sub" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_actor" ON "audit_log" USING btree ("actor_sub");--> statement-breakpoint
CREATE INDEX "watcher_owner" ON "watcher" USING btree ("owner_sub");--> statement-breakpoint
ALTER TABLE "abuse_report" DROP COLUMN "reporter_user_id";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "actor_user_id";--> statement-breakpoint
ALTER TABLE "callsign_optout" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "gateway" DROP COLUMN "owner_user_id";--> statement-breakpoint
ALTER TABLE "gateway" DROP COLUMN "owner_org_id";--> statement-breakpoint
ALTER TABLE "site_setting" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "watcher" DROP COLUMN "user_id";