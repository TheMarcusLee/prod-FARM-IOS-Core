CREATE TABLE "scheduler"."caption_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"original_asset_id" uuid,
	"kind" text NOT NULL,
	"duration_ms" integer,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"normalized" boolean DEFAULT false NOT NULL,
	"sha256" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"caption" text,
	"hashtags" text[] DEFAULT '{}' NOT NULL,
	"poster_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "scheduler"."content_set_items" (
	"set_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "content_set_items_set_id_item_id_pk" PRIMARY KEY("set_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "scheduler"."content_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."drip_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"date" date NOT NULL,
	"schedule_id" uuid,
	"item_id" uuid NOT NULL,
	"planned_for" timestamp with time zone NOT NULL,
	"used_marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."drip_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_udid" text NOT NULL,
	"account" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"posts_per_day" integer DEFAULT 1 NOT NULL,
	"window_start" text DEFAULT '09:00' NOT NULL,
	"window_end" text DEFAULT '21:00' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"min_gap_minutes" integer DEFAULT 90 NOT NULL,
	"destination" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'tag' NOT NULL,
	"set_id" uuid,
	"tag" text,
	"caption_template_id" uuid,
	"pick_order" text DEFAULT 'random' NOT NULL,
	"avoid_reuse_days" integer DEFAULT 30 NOT NULL,
	"last_planned_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler"."content_items" ADD CONSTRAINT "content_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "scheduler"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."content_items" ADD CONSTRAINT "content_items_original_asset_id_assets_id_fk" FOREIGN KEY ("original_asset_id") REFERENCES "scheduler"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."content_set_items" ADD CONSTRAINT "content_set_items_set_id_content_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "scheduler"."content_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."content_set_items" ADD CONSTRAINT "content_set_items_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "scheduler"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_plans" ADD CONSTRAINT "drip_plans_rule_id_drip_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "scheduler"."drip_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_plans" ADD CONSTRAINT "drip_plans_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "scheduler"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_plans" ADD CONSTRAINT "drip_plans_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "scheduler"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD CONSTRAINT "drip_rules_set_id_content_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "scheduler"."content_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD CONSTRAINT "drip_rules_caption_template_id_caption_templates_id_fk" FOREIGN KEY ("caption_template_id") REFERENCES "scheduler"."caption_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "caption_templates_name_idx" ON "scheduler"."caption_templates" USING btree ("name");--> statement-breakpoint
CREATE INDEX "content_items_status_idx" ON "scheduler"."content_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "content_items_last_used_idx" ON "scheduler"."content_items" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "content_set_items_order_idx" ON "scheduler"."content_set_items" USING btree ("set_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "content_sets_name_idx" ON "scheduler"."content_sets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "drip_plans_rule_date_idx" ON "scheduler"."drip_plans" USING btree ("rule_id","date");--> statement-breakpoint
CREATE INDEX "drip_plans_schedule_idx" ON "scheduler"."drip_plans" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "drip_rules_device_idx" ON "scheduler"."drip_rules" USING btree ("device_udid","account");