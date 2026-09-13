CREATE TYPE "public"."folder_role" AS ENUM('inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all', 'other');--> statement-breakpoint
CREATE TYPE "public"."mail_auth_type" AS ENUM('password', 'oauth2');--> statement-breakpoint
CREATE TYPE "public"."mail_op_status" AS ENUM('pending', 'applying', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mail_provider" AS ENUM('imap', 'gmail', 'outlook');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('idle', 'syncing', 'error', 'disabled');--> statement-breakpoint
CREATE TABLE "ai_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"category" text,
	"priority" text,
	"summary" text,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_annotations_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"part" text NOT NULL,
	"filename" text,
	"mime_type" text,
	"size" integer,
	"content_id" text,
	"inline" boolean DEFAULT false NOT NULL,
	"cached_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"role" "folder_role" DEFAULT 'other' NOT NULL,
	"uid_validity" bigint,
	"uid_next" bigint,
	"highest_modseq" bigint,
	"total_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"subscribed" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"preset_id" text,
	"email" text NOT NULL,
	"display_name" text,
	"auth_type" "mail_auth_type" DEFAULT 'password' NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer DEFAULT 465 NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"credentials_enc" text NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"sync_window_days" integer DEFAULT 30 NOT NULL,
	"sync_status" "sync_status" DEFAULT 'idle' NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "mail_op_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" text,
	"thread_id" text,
	"subject" text,
	"from_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"date" timestamp with time zone,
	"internal_date" timestamp with time zone,
	"size" integer,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"snippet" text,
	"text_body" text,
	"html_body" text,
	"headers" jsonb,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"body_fetched_at" timestamp with time zone,
	"gm_labels" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_annotations" ADD CONSTRAINT "ai_annotations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_ops" ADD CONSTRAINT "mail_ops_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_path_uq" ON "folders" USING btree ("account_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_user_email_uq" ON "mail_accounts" USING btree ("user_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_ops_idem_uq" ON "mail_ops" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mail_ops_status_idx" ON "mail_ops" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_folder_uid_uq" ON "messages" USING btree ("folder_id","uid");--> statement-breakpoint
CREATE INDEX "messages_account_date_idx" ON "messages" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_message_id_idx" ON "messages" USING btree ("message_id");