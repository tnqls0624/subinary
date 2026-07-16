CREATE TYPE "public"."candidate_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."memory_source_type" AS ENUM('chunk', 'slack_message', 'card_sms', 'manual');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('candidate', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('event', 'fact', 'decision', 'preference', 'procedure', 'incident', 'task');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "memory_type" NOT NULL,
	"subject" text NOT NULL,
	"content" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"confidence" integer NOT NULL,
	"status" "memory_status" DEFAULT 'approved' NOT NULL,
	"supersedes_memory_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "memory_type" NOT NULL,
	"subject" text NOT NULL,
	"subject_hash" text NOT NULL,
	"content" text NOT NULL,
	"confidence" integer NOT NULL,
	"source_chunk_id" uuid,
	"source_ref_id" text,
	"status" "candidate_status" DEFAULT 'pending' NOT NULL,
	"extracted_at" timestamp with time zone NOT NULL,
	"promoted_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidates_workspace_chunk_type_hash_unique" UNIQUE("workspace_id","source_chunk_id","type","subject_hash")
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_type" "memory_source_type" NOT NULL,
	"source_ref_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_sources_memory_id_source_type_source_ref_id_unique" UNIQUE("memory_id","source_type","source_ref_id")
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"content" text NOT NULL,
	"change_reason" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_versions_memory_id_version_unique" UNIQUE("memory_id","version")
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_memory_id_memories_id_fk" FOREIGN KEY ("supersedes_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_chunk_id_chunks_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_promoted_memory_id_memories_id_fk" FOREIGN KEY ("promoted_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_workspace_id_idx" ON "memories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "memories_workspace_id_type_idx" ON "memories" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "memories_workspace_id_status_idx" ON "memories" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "memory_candidates_workspace_id_idx" ON "memory_candidates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "memory_candidates_workspace_id_status_idx" ON "memory_candidates" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "memory_sources_memory_id_idx" ON "memory_sources" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_versions_memory_id_idx" ON "memory_versions" USING btree ("memory_id");