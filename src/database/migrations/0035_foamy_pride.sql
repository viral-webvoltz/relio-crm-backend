ALTER TABLE "activities" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "organization_mail_settings" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_mail_settings" ADD COLUMN "sync_error" text;--> statement-breakpoint
CREATE INDEX "activities_org_thread_idx" ON "activities" USING btree ("organization_id","thread_id") WHERE "activities"."thread_id" is not null;