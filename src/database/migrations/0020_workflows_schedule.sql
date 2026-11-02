ALTER TABLE "workflow_events" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "last_scheduled_on" date;