CREATE TABLE "scheduler"."events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scheduler"."events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"device_udid" text,
	"execution_id" uuid,
	"schedule_id" uuid,
	"title" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "scheduler"."events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_device_idx" ON "scheduler"."events" USING btree ("device_udid");