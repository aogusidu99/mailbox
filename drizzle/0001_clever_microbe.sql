ALTER TABLE "folders" ADD COLUMN "no_select" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "initial_sync_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_folder_date_idx" ON "messages" USING btree ("folder_id","date");