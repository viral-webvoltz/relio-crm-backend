ALTER TABLE "activities" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "email_address" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_org_message_id_uq" ON "activities" USING btree ("organization_id","message_id") WHERE "activities"."message_id" is not null;