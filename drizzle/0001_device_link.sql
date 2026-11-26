CREATE TABLE "device_link" (
	"user_code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"watcher_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN IF to_regclass('public."user"') IS NOT NULL THEN ALTER TABLE "device_link" ADD CONSTRAINT "device_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
ALTER TABLE "device_link" ADD CONSTRAINT "device_link_watcher_id_fkey" FOREIGN KEY ("watcher_id") REFERENCES "public"."watcher"("id") ON DELETE cascade ON UPDATE no action;