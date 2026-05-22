CREATE TABLE "docuseal_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"docuseal_event_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docuseal_audit_docuseal_event_id_unique" UNIQUE("docuseal_event_id")
);
--> statement-breakpoint
CREATE TABLE "docuseal_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"api_token" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_health_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docuseal_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"template_id" uuid NOT NULL,
	"docuseal_id" text NOT NULL,
	"status" text NOT NULL,
	"sent_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"signed_pdf_url" text,
	"void_reason" text,
	"decline_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docuseal_submitters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"order" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"signed_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docuseal_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"docuseal_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" uuid,
	"merge_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signer_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_docuseal_audit_submission" ON "docuseal_audit" USING btree ("submission_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_docuseal_config_org_active" ON "docuseal_config" USING btree ("org_id") WHERE "docuseal_config"."is_active" = true;--> statement-breakpoint
CREATE INDEX "idx_docuseal_config_org_id" ON "docuseal_config" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_docuseal_submissions_org_status" ON "docuseal_submissions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_docuseal_submissions_project" ON "docuseal_submissions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_docuseal_submissions_template" ON "docuseal_submissions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_docuseal_submitters_submission" ON "docuseal_submitters" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "idx_docuseal_templates_org_category" ON "docuseal_templates" USING btree ("org_id","category");