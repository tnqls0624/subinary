CREATE TABLE "rag_retrieval_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"feedback_event_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"chunk_revision_id" uuid NOT NULL,
	"query_object_key" text NOT NULL,
	"query_hash" text NOT NULL,
	"label_schema_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_retrieval_examples_feedback_unique" UNIQUE("feedback_event_id"),
	CONSTRAINT "rag_retrieval_examples_workspace_query_chunk_unique" UNIQUE("workspace_id","query_hash","chunk_revision_id"),
	CONSTRAINT "rag_retrieval_examples_query_hash_check" CHECK ("rag_retrieval_examples"."query_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rag_retrieval_examples_revocation_check" CHECK (("rag_retrieval_examples"."revoked_at" is null) = ("rag_retrieval_examples"."revocation_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD COLUMN "gate_details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_retrieval_examples" ADD CONSTRAINT "rag_retrieval_examples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_retrieval_examples" ADD CONSTRAINT "rag_retrieval_examples_feedback_event_id_feedback_events_id_fk" FOREIGN KEY ("feedback_event_id") REFERENCES "public"."feedback_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_retrieval_examples" ADD CONSTRAINT "rag_retrieval_examples_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_retrieval_examples" ADD CONSTRAINT "rag_retrieval_examples_chunk_revision_id_chunk_revisions_id_fk" FOREIGN KEY ("chunk_revision_id") REFERENCES "public"."chunk_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_retrieval_examples_workspace_occurred_at_idx" ON "rag_retrieval_examples" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "rag_retrieval_examples_chunk_revision_id_idx" ON "rag_retrieval_examples" USING btree ("chunk_revision_id");