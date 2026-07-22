CREATE TABLE "notification_dedupe" (
	"dedupe_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
