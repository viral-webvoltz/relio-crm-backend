CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"record_id" uuid,
	"values" jsonb NOT NULL,
	"changed" jsonb NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_events_due_idx" ON "workflow_events" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_event_uq" ON "workflow_runs" USING btree ("workflow_id","event_id") WHERE "workflow_runs"."event_id" is not null;