CREATE TABLE "revoked_key" (
	"jti" text PRIMARY KEY NOT NULL,
	"sub" text NOT NULL,
	"exp" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "revoked_key_source_check" CHECK (source = ANY (ARRAY['pull'::text, 'webhook'::text]))
);
--> statement-breakpoint
CREATE TABLE "watcher_key" (
	"jti" text PRIMARY KEY NOT NULL,
	"watcher_id" uuid NOT NULL,
	"owner_sub" text NOT NULL,
	"key_exp" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watcher_key" ADD CONSTRAINT "watcher_key_watcher_id_fkey" FOREIGN KEY ("watcher_id") REFERENCES "public"."watcher"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "revoked_key_exp" ON "revoked_key" USING btree ("exp");--> statement-breakpoint
CREATE INDEX "revoked_key_pull" ON "revoked_key" USING btree ("revoked_at") WHERE source = 'pull';--> statement-breakpoint
CREATE INDEX "watcher_key_watcher" ON "watcher_key" USING btree ("watcher_id");