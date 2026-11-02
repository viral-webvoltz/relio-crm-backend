CREATE TABLE "organization_mail_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"client_id" text NOT NULL,
	"client_secret_sealed" text NOT NULL,
	"refresh_token_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_mail_settings" ADD CONSTRAINT "organization_mail_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_mail_settings_org_uq" ON "organization_mail_settings" USING btree ("organization_id");