CREATE TYPE "public"."device_credential_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android', 'other');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"status" "device_credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_nonces_device_id_nonce_unique" UNIQUE("device_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "registered_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"status" "device_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_nonces" ADD CONSTRAINT "device_nonces_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_credentials_device_id_idx" ON "device_credentials" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "device_nonces_expires_at_idx" ON "device_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "registered_devices_household_id_idx" ON "registered_devices" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "registered_devices_member_id_idx" ON "registered_devices" USING btree ("member_id");