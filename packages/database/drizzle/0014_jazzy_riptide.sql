CREATE TYPE "public"."dataset_snapshot_status" AS ENUM('draft', 'validated', 'approved', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."dataset_split" AS ENUM('train', 'validation', 'test');--> statement-breakpoint
CREATE TABLE "chunk_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"text" text NOT NULL,
	"chunker_version" text NOT NULL,
	"redaction_version" text NOT NULL,
	"pipeline_run_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_revisions_chunk_revision_unique" UNIQUE("chunk_id","revision"),
	CONSTRAINT "chunk_revisions_revision_check" CHECK ("chunk_revisions"."revision" > 0),
	CONSTRAINT "chunk_revisions_validity_check" CHECK ("chunk_revisions"."valid_until" is null or "chunk_revisions"."valid_until" > "chunk_revisions"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "dataset_snapshot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_snapshot_id" uuid NOT NULL,
	"feedback_event_id" uuid NOT NULL,
	"chunk_revision_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"split" "dataset_split" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_snapshot_items_snapshot_feedback_unique" UNIQUE("dataset_snapshot_id","feedback_event_id")
);
--> statement-breakpoint
CREATE TABLE "dataset_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"household_id" uuid,
	"task" text NOT NULL,
	"version" text NOT NULL,
	"schema_version" text NOT NULL,
	"artifact_key" text NOT NULL,
	"artifact_hash" text NOT NULL,
	"manifest_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"split_policy" jsonb NOT NULL,
	"consent_scope" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"status" "dataset_snapshot_status" DEFAULT 'draft' NOT NULL,
	"pipeline_run_id" uuid,
	"created_by" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_snapshots_scope_check" CHECK (num_nonnulls("dataset_snapshots"."workspace_id", "dataset_snapshots"."household_id") = 1),
	CONSTRAINT "dataset_snapshots_row_count_check" CHECK ("dataset_snapshots"."row_count" >= 0),
	CONSTRAINT "dataset_snapshots_revocation_check" CHECK ("dataset_snapshots"."status" <> 'revoked' or "dataset_snapshots"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "embedding_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_revision_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_revision" text NOT NULL,
	"preprocessing_version" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector(256) NOT NULL,
	"embedding_hash" text NOT NULL,
	"pipeline_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_versions_revision_model_preprocess_unique" UNIQUE("chunk_revision_id","provider","model","model_revision","preprocessing_version"),
	CONSTRAINT "embedding_versions_dim_check" CHECK ("embedding_versions"."dim" > 0)
);
--> statement-breakpoint
CREATE TABLE "lineage_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_node_type" text NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_type" text NOT NULL,
	"to_node_id" uuid NOT NULL,
	"transform_version" text NOT NULL,
	"pipeline_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineage_edges_from_to_transform_unique" UNIQUE("from_node_type","from_node_id","to_node_type","to_node_id","transform_version"),
	CONSTRAINT "lineage_edges_self_check" CHECK ("lineage_edges"."from_node_type" <> "lineage_edges"."to_node_type" or "lineage_edges"."from_node_id" <> "lineage_edges"."to_node_id")
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"object_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"parser_schema_version" text NOT NULL,
	"consent_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_tombstone" boolean DEFAULT false NOT NULL,
	"pipeline_run_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revisions_item_revision_unique" UNIQUE("source_item_id","revision"),
	CONSTRAINT "source_revisions_revision_check" CHECK ("source_revisions"."revision" > 0),
	CONSTRAINT "source_revisions_size_bytes_check" CHECK ("source_revisions"."size_bytes" >= 0),
	CONSTRAINT "source_revisions_validity_check" CHECK ("source_revisions"."valid_until" is null or "source_revisions"."valid_until" > "source_revisions"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "chunk_revisions" ADD CONSTRAINT "chunk_revisions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_revisions" ADD CONSTRAINT "chunk_revisions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshot_items" ADD CONSTRAINT "dataset_snapshot_items_dataset_snapshot_id_dataset_snapshots_id_fk" FOREIGN KEY ("dataset_snapshot_id") REFERENCES "public"."dataset_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshot_items" ADD CONSTRAINT "dataset_snapshot_items_feedback_event_id_feedback_events_id_fk" FOREIGN KEY ("feedback_event_id") REFERENCES "public"."feedback_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshot_items" ADD CONSTRAINT "dataset_snapshot_items_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshots" ADD CONSTRAINT "dataset_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshots" ADD CONSTRAINT "dataset_snapshots_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshots" ADD CONSTRAINT "dataset_snapshots_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_snapshots" ADD CONSTRAINT "dataset_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_versions" ADD CONSTRAINT "embedding_versions_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_versions" ADD CONSTRAINT "embedding_versions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "source_revisions" (
	"source_item_id",
	"revision",
	"object_key",
	"content_hash",
	"size_bytes",
	"parser_schema_version",
	"consent_scope",
	"is_tombstone",
	"valid_from",
	"created_at"
)
SELECT
	"id",
	1,
	"object_key",
	"content_hash",
	"size_bytes",
	CASE "kind"::text
		WHEN 'slack' THEN 'slack-raw-v1'
		WHEN 'card_sms' THEN 'card-sms-raw-v1'
		ELSE 'manual-raw-v1'
	END,
	CASE
		WHEN "workspace_id" IS NOT NULL THEN '{"mode":"workspace-only"}'::jsonb
		WHEN "household_id" IS NOT NULL THEN '{"mode":"household-only"}'::jsonb
		ELSE '{"mode":"unscoped"}'::jsonb
	END,
	false,
	"received_at",
	"created_at"
FROM "source_items"
ON CONFLICT ("source_item_id", "revision") DO NOTHING;--> statement-breakpoint
UPDATE "source_items" AS source
SET "current_revision_id" = revision."id"
FROM "source_revisions" AS revision
WHERE revision."source_item_id" = source."id"
	AND revision."valid_until" IS NULL;--> statement-breakpoint
WITH "chunk_source_sets" AS (
	SELECT
		chunk."id" AS "chunk_id",
		CASE
			WHEN count(source."current_revision_id") = 0 THEN '[]'
			ELSE '["' || string_agg(
				DISTINCT source."current_revision_id"::text,
				'","' ORDER BY source."current_revision_id"::text
			) || '"]'
		END AS "source_ids_json"
	FROM "chunks" AS chunk
	LEFT JOIN "slack_workspaces" AS slack_workspace
		ON slack_workspace."workspace_id" = chunk."workspace_id"
	LEFT JOIN "slack_messages" AS message
		ON message."slack_workspace_id" = slack_workspace."id"
		AND (
			(chunk."source_type" = 'slack_message' AND message."ts" = chunk."source_ref_id")
			OR (chunk."source_type" = 'slack_thread' AND message."thread_ts" = chunk."source_ref_id")
		)
	LEFT JOIN "source_items" AS source
		ON source."id" = message."source_item_id"
	GROUP BY chunk."id"
)
INSERT INTO "chunk_revisions" (
	"chunk_id",
	"revision",
	"content_hash",
	"source_fingerprint",
	"text",
	"chunker_version",
	"redaction_version",
	"valid_from",
	"created_at"
)
SELECT
	chunk."id",
	1,
	encode(sha256(convert_to(chunk."text", 'UTF8')), 'hex'),
	encode(sha256(convert_to(source_set."source_ids_json", 'UTF8')), 'hex'),
	chunk."text",
	'slack-chunk-v1',
	'none-v1',
	chunk."created_at",
	chunk."created_at"
FROM "chunks" AS chunk
INNER JOIN "chunk_source_sets" AS source_set
	ON source_set."chunk_id" = chunk."id"
ON CONFLICT ("chunk_id", "revision") DO NOTHING;--> statement-breakpoint
UPDATE "chunks" AS chunk
SET "current_revision_id" = revision."id"
FROM "chunk_revisions" AS revision
WHERE revision."chunk_id" = chunk."id"
	AND revision."valid_until" IS NULL;--> statement-breakpoint
INSERT INTO "lineage_edges" (
	"from_node_type",
	"from_node_id",
	"to_node_type",
	"to_node_id",
	"transform_version"
)
SELECT DISTINCT
	'source_revision',
	source."current_revision_id",
	'chunk_revision',
	chunk."current_revision_id",
	'slack-chunk-v1+none-v1'
FROM "chunks" AS chunk
INNER JOIN "slack_workspaces" AS slack_workspace
	ON slack_workspace."workspace_id" = chunk."workspace_id"
INNER JOIN "slack_messages" AS message
	ON message."slack_workspace_id" = slack_workspace."id"
	AND (
		(chunk."source_type" = 'slack_message' AND message."ts" = chunk."source_ref_id")
		OR (chunk."source_type" = 'slack_thread' AND message."thread_ts" = chunk."source_ref_id")
	)
INNER JOIN "source_items" AS source
	ON source."id" = message."source_item_id"
WHERE source."current_revision_id" IS NOT NULL
	AND chunk."current_revision_id" IS NOT NULL
ON CONFLICT (
	"from_node_type",
	"from_node_id",
	"to_node_type",
	"to_node_id",
	"transform_version"
) DO NOTHING;--> statement-breakpoint
INSERT INTO "embedding_versions" (
	"chunk_revision_id",
	"provider",
	"model",
	"model_revision",
	"preprocessing_version",
	"dim",
	"embedding",
	"embedding_hash",
	"created_at"
)
SELECT
	chunk."current_revision_id",
	CASE
		WHEN embedding."model" LIKE 'gemini%' THEN 'gemini'
		WHEN embedding."model" LIKE 'text-embedding-%' THEN 'openai'
		ELSE 'mock'
	END,
	embedding."model",
	embedding."model",
	'raw-chunk-v1',
	embedding."dim",
	embedding."embedding",
	encode(sha256(convert_to(embedding."embedding"::text, 'UTF8')), 'hex'),
	embedding."created_at"
FROM "embeddings" AS embedding
INNER JOIN "chunks" AS chunk ON chunk."id" = embedding."chunk_id"
WHERE chunk."current_revision_id" IS NOT NULL
ON CONFLICT (
	"chunk_revision_id",
	"provider",
	"model",
	"model_revision",
	"preprocessing_version"
) DO NOTHING;--> statement-breakpoint
UPDATE "embeddings" AS embedding
SET "current_version_id" = version."id"
FROM "chunks" AS chunk, "embedding_versions" AS version
WHERE chunk."id" = embedding."chunk_id"
	AND version."chunk_revision_id" = chunk."current_revision_id"
	AND version."model" = embedding."model";--> statement-breakpoint
INSERT INTO "lineage_edges" (
	"from_node_type",
	"from_node_id",
	"to_node_type",
	"to_node_id",
	"transform_version"
)
SELECT
	'chunk_revision',
	version."chunk_revision_id",
	'embedding_version',
	version."id",
	version."preprocessing_version"
FROM "embedding_versions" AS version
ON CONFLICT (
	"from_node_type",
	"from_node_id",
	"to_node_type",
	"to_node_id",
	"transform_version"
) DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_revisions_chunk_current_unique" ON "chunk_revisions" USING btree ("chunk_id") WHERE "chunk_revisions"."valid_until" is null;--> statement-breakpoint
CREATE INDEX "chunk_revisions_content_transform_idx" ON "chunk_revisions" USING btree ("content_hash","chunker_version","redaction_version");--> statement-breakpoint
CREATE INDEX "chunk_revisions_pipeline_run_id_idx" ON "chunk_revisions" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "dataset_snapshot_items_chunk_revision_id_idx" ON "dataset_snapshot_items" USING btree ("chunk_revision_id");--> statement-breakpoint
CREATE INDEX "dataset_snapshot_items_target_idx" ON "dataset_snapshot_items" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_snapshots_workspace_task_version_unique" ON "dataset_snapshots" USING btree ("workspace_id","task","version") WHERE "dataset_snapshots"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_snapshots_household_task_version_unique" ON "dataset_snapshots" USING btree ("household_id","task","version") WHERE "dataset_snapshots"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "dataset_snapshots_status_created_at_idx" ON "dataset_snapshots" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "dataset_snapshots_artifact_hash_idx" ON "dataset_snapshots" USING btree ("artifact_hash");--> statement-breakpoint
CREATE INDEX "embedding_versions_model_dim_idx" ON "embedding_versions" USING btree ("model","dim");--> statement-breakpoint
CREATE INDEX "embedding_versions_pipeline_run_id_idx" ON "embedding_versions" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "lineage_edges_from_idx" ON "lineage_edges" USING btree ("from_node_type","from_node_id");--> statement-breakpoint
CREATE INDEX "lineage_edges_to_idx" ON "lineage_edges" USING btree ("to_node_type","to_node_id");--> statement-breakpoint
CREATE INDEX "lineage_edges_pipeline_run_id_idx" ON "lineage_edges" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_item_current_unique" ON "source_revisions" USING btree ("source_item_id") WHERE "source_revisions"."valid_until" is null;--> statement-breakpoint
CREATE INDEX "source_revisions_content_hash_idx" ON "source_revisions" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "source_revisions_pipeline_run_id_idx" ON "source_revisions" USING btree ("pipeline_run_id");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_current_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_current_version_id_embedding_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."embedding_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_current_revision_id_source_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;
