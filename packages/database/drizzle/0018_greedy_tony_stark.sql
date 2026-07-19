CREATE TABLE "graph_entity_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_chunk_id" uuid NOT NULL,
	"source_chunk_revision_id" uuid NOT NULL,
	"extractor_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_entity_mentions_revision_entity_extractor_unique" UNIQUE("source_chunk_revision_id","entity_id","extractor_version")
);
--> statement-breakpoint
ALTER TABLE "memory_candidates" DROP CONSTRAINT "memory_candidates_workspace_chunk_type_hash_unique";--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_ws_src_type_tgt_ref_unique";--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "source_chunk_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "extractor_version" text DEFAULT 'memory-rule-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "source_chunk_id" uuid;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "source_chunk_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "extractor_version" text DEFAULT 'graph-rule-v1' NOT NULL;--> statement-breakpoint
-- 기존 후보는 생성 당시 revision 정보가 없어 현재 projection revision으로 보수적으로 backfill한다.
UPDATE "memory_candidates" AS mc
SET "source_chunk_revision_id" = c."current_revision_id"
FROM "chunks" AS c
WHERE mc."source_chunk_id" = c."id"
  AND mc."source_chunk_revision_id" IS NULL
  AND c."current_revision_id" IS NOT NULL;--> statement-breakpoint
-- 명시적 supersede 관계는 제외하고 기존 규칙 추출 관계만 chunk 계보에 연결한다.
UPDATE "relationships" AS r
SET
	"source_chunk_id" = c."id",
	"source_chunk_revision_id" = c."current_revision_id"
FROM "chunks" AS c
WHERE r."workspace_id" = c."workspace_id"
  AND r."source_ref_id" = c."source_ref_id"
  AND r."supersedes_relationship_id" IS NULL
  AND r."source_chunk_id" IS NULL
  AND c."current_revision_id" IS NOT NULL;--> statement-breakpoint
-- 기존 관계 endpoint를 최소 entity mention 계보로 승격한다. 관계가 없는 단일 entity는
-- 다음 전체 graph rebuild가 정확한 mention을 채운다.
INSERT INTO "graph_entity_mentions" (
	"workspace_id",
	"entity_id",
	"source_chunk_id",
	"source_chunk_revision_id",
	"extractor_version",
	"observed_at",
	"valid_from",
	"valid_until"
)
SELECT
	r."workspace_id",
	endpoint."entity_id",
	r."source_chunk_id",
	r."source_chunk_revision_id",
	r."extractor_version",
	COALESCE(c."occurred_at", r."valid_from", r."created_at"),
	COALESCE(r."valid_from", r."created_at"),
	r."valid_until"
FROM "relationships" AS r
JOIN "chunks" AS c ON c."id" = r."source_chunk_id"
CROSS JOIN LATERAL (
	VALUES (r."source_entity_id"), (r."target_entity_id")
) AS endpoint("entity_id")
WHERE r."source_chunk_revision_id" IS NOT NULL
ON CONFLICT ("source_chunk_revision_id", "entity_id", "extractor_version") DO NOTHING;--> statement-breakpoint
ALTER TABLE "graph_entity_mentions" ADD CONSTRAINT "graph_entity_mentions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_entity_mentions" ADD CONSTRAINT "graph_entity_mentions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_entity_mentions" ADD CONSTRAINT "graph_entity_mentions_source_chunk_id_chunks_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_entity_mentions" ADD CONSTRAINT "graph_entity_mentions_source_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("source_chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_entity_mentions_workspace_id_idx" ON "graph_entity_mentions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "graph_entity_mentions_source_chunk_id_idx" ON "graph_entity_mentions" USING btree ("source_chunk_id");--> statement-breakpoint
CREATE INDEX "graph_entity_mentions_entity_id_idx" ON "graph_entity_mentions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "graph_entity_mentions_current_idx" ON "graph_entity_mentions" USING btree ("entity_id","valid_until") WHERE "graph_entity_mentions"."valid_until" is null;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("source_chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_chunk_id_chunks_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("source_chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidates_revision_type_hash_extractor_unique" ON "memory_candidates" USING btree ("workspace_id","source_chunk_revision_id","type","subject_hash","extractor_version") WHERE "memory_candidates"."source_chunk_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_candidates_source_chunk_revision_id_idx" ON "memory_candidates" USING btree ("source_chunk_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_revision_edge_extractor_unique" ON "relationships" USING btree ("workspace_id","source_entity_id","type","target_entity_id","source_chunk_revision_id","extractor_version") WHERE "relationships"."source_chunk_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "relationships_source_chunk_id_idx" ON "relationships" USING btree ("source_chunk_id");--> statement-breakpoint
CREATE INDEX "relationships_source_chunk_revision_id_idx" ON "relationships" USING btree ("source_chunk_revision_id");
