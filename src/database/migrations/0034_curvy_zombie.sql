DROP INDEX "organization_mail_settings_org_uq";--> statement-breakpoint
ALTER TABLE "organization_mail_settings" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organization_mail_settings" SET "is_active" = true, "from_email" = lower("from_email");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_mail_settings_org_email_uq" ON "organization_mail_settings" USING btree ("organization_id","from_email");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_mail_settings_active_uq" ON "organization_mail_settings" USING btree ("organization_id") WHERE "organization_mail_settings"."is_active";