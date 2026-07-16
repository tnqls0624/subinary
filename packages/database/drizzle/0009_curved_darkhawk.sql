CREATE TYPE "public"."entity_type" AS ENUM('person', 'technology', 'project', 'decision', 'incident', 'topic');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('relates_to', 'resolves', 'works_on', 'uses', 'decides', 'supersedes');--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "entity_type" NOT NULL,
	"name" text NOT NULL,
	"canonical_name" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_workspace_id_type_canonical_name_unique" UNIQUE("workspace_id","type","canonical_name")
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"type" "relationship_type" NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"supersedes_relationship_id" uuid,
	"source_ref_id" text,
	"confidence" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_ws_src_type_tgt_ref_unique" UNIQUE("workspace_id","source_entity_id","type","target_entity_id","source_ref_id")
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_supersedes_relationship_id_relationships_id_fk" FOREIGN KEY ("supersedes_relationship_id") REFERENCES "public"."relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_workspace_id_idx" ON "entities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "entities_workspace_id_type_idx" ON "entities" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "relationships_workspace_id_idx" ON "relationships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "relationships_source_entity_id_idx" ON "relationships" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "relationships_target_entity_id_idx" ON "relationships" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "relationships_workspace_id_type_idx" ON "relationships" USING btree ("workspace_id","type");