CREATE TABLE "abuse_report" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gateway_id" uuid,
	"reporter_user_id" text,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "callsign_optout" (
	"callsign" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway_id" uuid NOT NULL,
	"frequency_hz" bigint NOT NULL,
	"modem" text NOT NULL,
	"variant" text,
	"modem_version" text,
	"service_code" text DEFAULT 'PUBLIC' NOT NULL,
	"operating_hours" text DEFAULT '00-23' NOT NULL,
	"antenna" text DEFAULT '' NOT NULL,
	"radio_range" text DEFAULT '' NOT NULL,
	"gridsquare" text,
	"baud" text DEFAULT '0' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"winlink_supported_modes" text,
	"winlink_mode" integer,
	"compat_supported_modes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_frequency_hz_check" CHECK (frequency_hz > 0)
);
--> statement-breakpoint
CREATE TABLE "gateway" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"callsign" text NOT NULL,
	"base_callsign" text NOT NULL,
	"owner_user_id" text,
	"latitude" double precision,
	"longitude" double precision,
	"gridsquare" text,
	"location_precision" text DEFAULT 'exact' NOT NULL,
	"comments" text DEFAULT '' NOT NULL,
	"software" text,
	"winlink_listed" boolean DEFAULT false NOT NULL,
	"emcomm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"hidden_reason" text,
	"last_heartbeat_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"winlink_last_status" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"live" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_comments" text DEFAULT '' NOT NULL,
	"claimed_at" timestamp with time zone,
	"owner_org_id" text,
	CONSTRAINT "gateway_source_callsign_key" UNIQUE("source","callsign"),
	CONSTRAINT "gateway_source_check" CHECK (source = ANY (ARRAY['openrms'::text, 'winlink'::text])),
	CONSTRAINT "gateway_location_precision_check" CHECK (location_precision = ANY (ARRAY['exact'::text, 'grid6'::text, 'grid4'::text]))
);
--> statement-breakpoint
CREATE TABLE "import_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"gateways" integer,
	"channels" integer,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "site_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"watcher_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"ts_end" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modem" text,
	"dial_hz" bigint,
	"kind" text,
	"from_call" text,
	"to_crc" text,
	"caller_crc" text,
	"called_crc" text,
	"snr_db" real,
	"payload" jsonb NOT NULL,
	"accepted" boolean,
	"hint" jsonb,
	CONSTRAINT "watch_event_watcher_id_event_id_key" UNIQUE("watcher_id","event_id"),
	CONSTRAINT "watch_event_type_check" CHECK (type = ANY (ARRAY['frame'::text, 'attempt'::text, 'coverage'::text, 'status'::text]))
);
--> statement-breakpoint
CREATE TABLE "watcher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"gridsquare" text,
	"location_precision" text DEFAULT 'grid4' NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"api_key_id" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"last_seen_at" timestamp with time zone,
	"last_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watcher_location_precision_check" CHECK (location_precision = ANY (ARRAY['grid4'::text, 'grid6'::text, 'hidden'::text]))
);
--> statement-breakpoint
ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateway"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "callsign_optout" ADD CONSTRAINT "callsign_optout_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateway"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "gateway" ADD CONSTRAINT "gateway_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."organization"') IS NOT NULL THEN ALTER TABLE "gateway" ADD CONSTRAINT "gateway_owner_org_id_fkey" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "site_setting" ADD CONSTRAINT "site_setting_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
ALTER TABLE "watch_event" ADD CONSTRAINT "watch_event_watcher_id_fkey" FOREIGN KEY ("watcher_id") REFERENCES "public"."watcher"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "watcher" ADD CONSTRAINT "watcher_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE INDEX "channel_gateway" ON "channel" USING btree ("gateway_id");--> statement-breakpoint
CREATE INDEX "channel_modem" ON "channel" USING btree ("modem");--> statement-breakpoint
CREATE INDEX "gateway_base_callsign" ON "gateway" USING btree ("base_callsign");--> statement-breakpoint
CREATE INDEX "gateway_owner" ON "gateway" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "gateway_owner_org" ON "gateway" USING btree ("owner_org_id");--> statement-breakpoint
CREATE INDEX "watch_event_crc" ON "watch_event" USING btree ("called_crc","to_crc") WHERE (type = 'frame'::text);--> statement-breakpoint
CREATE INDEX "watch_event_ts" ON "watch_event" USING btree ("ts" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "watcher_api_key" ON "watcher" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "watcher_user" ON "watcher" USING btree ("user_id");