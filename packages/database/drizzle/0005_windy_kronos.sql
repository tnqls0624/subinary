CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'company');--> statement-breakpoint
CREATE TABLE "slack_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_workspace_id" uuid NOT NULL,
	"slack_channel_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_channels_slack_workspace_id_slack_channel_id_unique" UNIQUE("slack_workspace_id","slack_channel_id")
);
--> statement-breakpoint
CREATE TABLE "slack_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_workspace_id" uuid NOT NULL,
	"slack_channel_id" uuid NOT NULL,
	"slack_user_id" text,
	"ts" text NOT NULL,
	"thread_ts" text,
	"text" text NOT NULL,
	"edited_ts" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_messages_slack_channel_id_ts_unique" UNIQUE("slack_channel_id","ts")
);
--> statement-breakpoint
CREATE TABLE "slack_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_workspace_id" uuid NOT NULL,
	"slack_channel_id" uuid NOT NULL,
	"thread_ts" text NOT NULL,
	"root_ts" text NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_threads_slack_channel_id_thread_ts_unique" UNIQUE("slack_channel_id","thread_ts")
);
--> statement-breakpoint
CREATE TABLE "slack_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_workspace_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"name" text NOT NULL,
	"real_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_users_slack_workspace_id_slack_user_id_unique" UNIQUE("slack_workspace_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "slack_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_team_id" text,
	"name" text NOT NULL,
	"my_slack_user_id" text,
	"last_imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_workspaces_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_slack_workspace_id_slack_workspaces_id_fk" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_messages" ADD CONSTRAINT "slack_messages_slack_workspace_id_slack_workspaces_id_fk" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_messages" ADD CONSTRAINT "slack_messages_slack_channel_id_slack_channels_id_fk" FOREIGN KEY ("slack_channel_id") REFERENCES "public"."slack_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_messages" ADD CONSTRAINT "slack_messages_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_slack_workspace_id_slack_workspaces_id_fk" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_slack_channel_id_slack_channels_id_fk" FOREIGN KEY ("slack_channel_id") REFERENCES "public"."slack_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_users" ADD CONSTRAINT "slack_users_slack_workspace_id_slack_workspaces_id_fk" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ADD CONSTRAINT "slack_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_messages_slack_workspace_id_idx" ON "slack_messages" USING btree ("slack_workspace_id");--> statement-breakpoint
CREATE INDEX "slack_messages_slack_channel_id_idx" ON "slack_messages" USING btree ("slack_channel_id");--> statement-breakpoint
CREATE INDEX "slack_messages_thread_ts_idx" ON "slack_messages" USING btree ("thread_ts");--> statement-breakpoint
CREATE INDEX "slack_messages_occurred_at_idx" ON "slack_messages" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "slack_messages_text_trgm_idx" ON "slack_messages" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "workspaces_owner_user_id_idx" ON "workspaces" USING btree ("owner_user_id");