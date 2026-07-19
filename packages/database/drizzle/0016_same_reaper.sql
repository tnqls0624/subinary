ALTER TABLE "chunk_revisions" ADD COLUMN "is_tombstone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk_revisions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_events" ADD COLUMN "reprocess_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_events" ADD COLUMN "last_reprocessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_events" ADD COLUMN "last_reprocessed_by" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_last_reprocessed_by_users_id_fk" FOREIGN KEY ("last_reprocessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_events_quarantined_at_idx" ON "data_events" USING btree ("quarantined_at");--> statement-breakpoint
ALTER TABLE "chunk_revisions" ADD CONSTRAINT "chunk_revisions_tombstone_text_check" CHECK (not "chunk_revisions"."is_tombstone" or "chunk_revisions"."text" = '');--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_reprocess_count_check" CHECK ("data_events"."reprocess_count" >= 0);