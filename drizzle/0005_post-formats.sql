ALTER TABLE "scheduler"."content_sets" ADD COLUMN "kind" text DEFAULT 'pool' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."content_sets" ADD COLUMN "cover_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."drip_rules" ADD COLUMN "format" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
-- Before this migration a set of two or three images was posted as one slideshow
-- and anything else was a pool. That rule is now the `kind` column, so the sets
-- it applied to are marked here; without this an upgraded farm would quietly
-- start posting those images one at a time.
UPDATE "scheduler"."content_sets" AS s SET "kind" = 'slideshow'
WHERE EXISTS (SELECT 1 FROM "scheduler"."content_set_items" i WHERE i."set_id" = s."id")
  AND NOT EXISTS (
    SELECT 1 FROM "scheduler"."content_set_items" i
    JOIN "scheduler"."content_items" c ON c."id" = i."item_id"
    WHERE i."set_id" = s."id" AND c."kind" <> 'image'
  )
  AND (SELECT count(*) FROM "scheduler"."content_set_items" i WHERE i."set_id" = s."id") BETWEEN 2 AND 3;
