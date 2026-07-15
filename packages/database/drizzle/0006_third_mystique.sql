ALTER TABLE "source_items" ALTER COLUMN "household_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_items_workspace_id_idx" ON "source_items" USING btree ("workspace_id");