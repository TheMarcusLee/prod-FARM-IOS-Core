CREATE TABLE "scheduler"."event_acks" (
	"token_id" text PRIMARY KEY NOT NULL,
	"up_to_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."push_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expo_push_token" text NOT NULL,
	"name" text NOT NULL,
	"min_severity" text DEFAULT 'warning' NOT NULL,
	"kinds" text[],
	"token_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "push_registrations_expo_push_token_unique" UNIQUE("expo_push_token")
);
--> statement-breakpoint
CREATE INDEX "push_registrations_token_idx" ON "scheduler"."push_registrations" USING btree ("token_id");