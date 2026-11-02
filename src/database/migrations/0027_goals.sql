CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"scope_type" text NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"period_type" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"target" bigint NOT NULL,
	"currency" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_scope_target" CHECK (("goals"."scope_type" = 'organization' and "goals"."user_id" is null and "goals"."team_id" is null)
        or ("goals"."scope_type" = 'user' and "goals"."user_id" is not null and "goals"."team_id" is null)
        or ("goals"."scope_type" = 'team' and "goals"."team_id" is not null and "goals"."user_id" is null)),
	CONSTRAINT "goals_period_order" CHECK ("goals"."end_date" >= "goals"."start_date")
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_org_period_idx" ON "goals" USING btree ("organization_id","end_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goals_user_idx" ON "goals" USING btree ("user_id");