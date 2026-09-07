-- Creators, per-account reuse, cross-posting and per-phone limits.
--
-- Nothing is back-filled on purpose. `content_uses` starts empty: there is no
-- per-account history to convert, and inventing rows from `content_items.
-- last_used_at` would credit a use to whichever account happens to be first in
-- a rule, which is a lie the reuse window would then act on. An item that has
-- been posted before is therefore reusable once, per account, and the table is
-- true from that point on. `content_items.used_count` / `last_used_at` are left
-- exactly as they are — they stay the global counters the library grid shows.
--
-- Every added `drip_rules` column has a default that reproduces today's
-- behaviour, so an existing rule keeps planning the same TikTok posts.

CREATE TABLE "scheduler"."content_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"network" text NOT NULL,
	"handle" text NOT NULL,
	"device_udid" text,
	"schedule_id" uuid,
	"execution_id" uuid,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."creator_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"network" text NOT NULL,
	"handle" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"device_udid" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."device_limits" (
	"device_udid" text PRIMARY KEY NOT NULL,
	"max_posts_per_day" integer DEFAULT 8 NOT NULL,
	"min_minutes_between_posts" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler"."drip_plans" ADD COLUMN "network" text DEFAULT 'tiktok' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_plans" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "network" text DEFAULT 'tiktok' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "networks" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "cross_post_gap_minutes" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "slide_size" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "network_captions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."content_uses" ADD CONSTRAINT "content_uses_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "scheduler"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."content_uses" ADD CONSTRAINT "content_uses_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "scheduler"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."creator_accounts" ADD CONSTRAINT "creator_accounts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "scheduler"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_uses_account_idx" ON "scheduler"."content_uses" USING btree ("item_id","network","handle","used_at");--> statement-breakpoint
CREATE INDEX "content_uses_recent_idx" ON "scheduler"."content_uses" USING btree ("used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_accounts_handle_idx" ON "scheduler"."creator_accounts" USING btree ("creator_id","network","handle");--> statement-breakpoint
CREATE INDEX "creator_accounts_network_idx" ON "scheduler"."creator_accounts" USING btree ("network","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_name_idx" ON "scheduler"."creators" USING btree ("name");--> statement-breakpoint
CREATE INDEX "creators_device_idx" ON "scheduler"."creators" USING btree ("device_udid");--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD CONSTRAINT "drip_rules_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "scheduler"."creators"("id") ON DELETE set null ON UPDATE no action;