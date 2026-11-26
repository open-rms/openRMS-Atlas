CREATE TABLE "account_cache" (
	"sub" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"callsign_verified" boolean DEFAULT false NOT NULL,
	"callsign_verified_method" text,
	"name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_club" (
	"id" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"name" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_club_member" (
	"club_id" text NOT NULL,
	"sub" text NOT NULL,
	"role" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_club_member_club_id_sub_pk" PRIMARY KEY("club_id","sub")
);
--> statement-breakpoint
CREATE TABLE "account_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"prefix" text NOT NULL,
	"start" text,
	"hash" text NOT NULL,
	"owner_sub" text NOT NULL,
	"watcher_id" uuid,
	"gateway_ids" jsonb,
	"rate_window_start" timestamp with time zone,
	"rate_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_kind_check" CHECK (kind = ANY (ARRAY['gateway'::text, 'watcher'::text]))
);
--> statement-breakpoint
ALTER TABLE "abuse_report" ADD COLUMN "reporter_sub" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_sub" text;--> statement-breakpoint
ALTER TABLE "callsign_optout" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "gateway" ADD COLUMN "owner_sub" text;--> statement-breakpoint
ALTER TABLE "gateway" ADD COLUMN "owner_club_id" text;--> statement-breakpoint
ALTER TABLE "site_setting" ADD COLUMN "updated_by_sub" text;--> statement-breakpoint
ALTER TABLE "watcher" ADD COLUMN "owner_sub" text;--> statement-breakpoint
ALTER TABLE "account_club_member" ADD CONSTRAINT "account_club_member_club_fkey" FOREIGN KEY ("club_id") REFERENCES "public"."account_club"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_cache_callsign" ON "account_cache" USING btree ("callsign");--> statement-breakpoint
CREATE UNIQUE INDEX "account_club_callsign" ON "account_club" USING btree ("callsign");--> statement-breakpoint
CREATE INDEX "account_club_member_sub" ON "account_club_member" USING btree ("sub");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash" ON "api_key" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_key_owner" ON "api_key" USING btree ("owner_sub");--> statement-breakpoint
CREATE INDEX "gateway_owner_sub" ON "gateway" USING btree ("owner_sub");--> statement-breakpoint
CREATE INDEX "gateway_owner_club" ON "gateway" USING btree ("owner_club_id");--> statement-breakpoint
-- Data: owner ids keep their values under the new Accounts names (identity.md: ids are kept).
UPDATE "gateway" SET "owner_sub" = "owner_user_id", "owner_club_id" = "owner_org_id";--> statement-breakpoint
UPDATE "watcher" SET "owner_sub" = "user_id";--> statement-breakpoint
UPDATE "abuse_report" SET "reporter_sub" = "reporter_user_id";--> statement-breakpoint
UPDATE "audit_log" SET "actor_sub" = "actor_user_id";--> statement-breakpoint
UPDATE "site_setting" SET "updated_by_sub" = "updated_by";--> statement-breakpoint
UPDATE "callsign_optout" SET "created_by_sub" = "created_by";--> statement-breakpoint
-- Seed the account cache and import keys from the Better Auth tables, when this database still
-- has them (a Directory that ran before openRMS-Accounts). Fresh databases skip this.
DO $$
BEGIN
  IF to_regclass('public."user"') IS NOT NULL THEN
    INSERT INTO "account_cache" (sub, callsign, callsign_verified, callsign_verified_method, name, role, banned)
    SELECT id, callsign, COALESCE("callsignVerified", false), "callsignVerifiedMethod", name, COALESCE(role, 'user'), COALESCE(banned, false)
      FROM "user" ON CONFLICT (sub) DO NOTHING;
  END IF;
  IF to_regclass('public.organization') IS NOT NULL THEN
    INSERT INTO "account_club" (id, callsign, name, verified)
    SELECT id, callsign, name, COALESCE("callsignVerified", false) FROM organization ON CONFLICT (id) DO NOTHING;
    INSERT INTO "account_club_member" (club_id, sub, role)
    SELECT "organizationId", "userId",
           CASE WHEN role LIKE '%owner%' THEN 'owner' WHEN role LIKE '%admin%' THEN 'admin' ELSE 'member' END
      FROM member ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('public.apikey') IS NOT NULL THEN
    -- Better Auth stored base64url(sha256(key)) unpadded in "key": the same hash we use.
    INSERT INTO "api_key" (id, kind, name, prefix, start, hash, owner_sub, watcher_id, gateway_ids, last_used_at, expires_at, revoked_at, created_at)
    SELECT k.id,
           CASE k."configId" WHEN 'watcher' THEN 'watcher' ELSE 'gateway' END,
           k.name, COALESCE(k.prefix, CASE k."configId" WHEN 'watcher' THEN 'ormsw_' ELSE 'orms_' END), k.start, k.key, k."referenceId",
           (SELECT w.id FROM watcher w WHERE w.api_key_id = k.id),
           CASE WHEN k."configId" = 'default' AND k.metadata IS NOT NULL AND k.metadata <> 'null'
                THEN (k.metadata::jsonb -> 'gatewayIds') END,
           k."lastRequest", k."expiresAt", CASE WHEN k.enabled = false THEN now() END, k."createdAt"
      FROM apikey k
     WHERE k."configId" IN ('default', 'watcher')
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
