CREATE TABLE "service_code_search" (
	"code" text NOT NULL,
	"day" date NOT NULL,
	"searchers" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "service_code_search_code_day_pk" PRIMARY KEY("code","day")
);
--> statement-breakpoint
CREATE INDEX "service_code_search_day" ON "service_code_search" USING btree ("day");