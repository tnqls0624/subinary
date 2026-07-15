CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_ref_id" text NOT NULL,
	"slack_channel_id" uuid,
	"channel_name" text,
	"text" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_workspace_id_source_type_source_ref_id_unique" UNIQUE("workspace_id","source_type","source_ref_id")
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_chunk_id_unique" UNIQUE("chunk_id")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_slack_channel_id_slack_channels_id_fk" FOREIGN KEY ("slack_channel_id") REFERENCES "public"."slack_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_workspace_id_idx" ON "chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chunks_occurred_at_idx" ON "chunks" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "chunks_text_trgm_idx" ON "chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "embeddings_embedding_hnsw_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);