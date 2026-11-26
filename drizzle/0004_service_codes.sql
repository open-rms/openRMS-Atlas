CREATE TABLE "service_code" (
	"code" text PRIMARY KEY NOT NULL,
	"visibility" text DEFAULT 'unlisted' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "service_code_code_check" CHECK (code ~ '^[A-Z0-9]{1,16}$'),
	CONSTRAINT "service_code_visibility_check" CHECK (visibility IN ('public', 'unlisted'))
);
--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "extra_service_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
INSERT INTO "service_code" ("code", "visibility", "description") VALUES
  ('PUBLIC', 'public', 'Default Winlink code: open to licensed amateurs (and maritime users)'),
  ('EMCOMM', 'public', 'Emergency communications: restricted or only during declared emergencies'),
  ('MERCURY', 'public', 'Mercury gateways (dialed as VARA)'),
  ('XARA', 'public', 'XARA gateways (open VARA-compatible modem)'),
  ('DATA2G', 'public', 'Data2G gateways (dialed as VARA)')
ON CONFLICT ("code") DO UPDATE SET "visibility" = 'public', "description" = EXCLUDED."description";
--> statement-breakpoint
-- Every other code already in use starts unlisted: never enumerated until staff promote it.
INSERT INTO "service_code" ("code")
SELECT DISTINCT upper(trim(c)) FROM (
  SELECT "service_code" AS c FROM "channel"
  UNION SELECT unnest("extra_service_codes") FROM "channel"
) s
WHERE upper(trim(c)) ~ '^[A-Z0-9]{1,16}$'
ON CONFLICT ("code") DO NOTHING;
