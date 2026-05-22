CREATE TYPE "public"."calculation_type" AS ENUM('percent_contract', 'ppw', 'tiered', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."assignment_role" AS ENUM('closer', 'setter', 'manager', 'override_recipient');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending', 'approved', 'paid', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('earned', 'adjusted', 'clawed_back', 'override_earned', 'adder', 'deduction');--> statement-breakpoint
CREATE TYPE "public"."adjustment_reason" AS ENUM('redesign', 'change_order', 'bonus', 'penalty', 'manual');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('draft', 'approved', 'paid');--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"calculation_type" "calculation_type" NOT NULL,
	"rules" jsonb NOT NULL,
	"earned_trigger_stage" text NOT NULL,
	"payable_trigger" jsonb NOT NULL,
	"clawback_config" jsonb,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "assignment_role" NOT NULL,
	"default_split_percent" numeric(5, 2) DEFAULT '100.00' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_commission_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"rep_assignments" jsonb NOT NULL,
	"plan_override_id" uuid,
	"contract_value" numeric(12, 2) NOT NULL,
	"system_size_kw" numeric(8, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_commission_configs_project_id" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "commission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"event_type" "event_type" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"triggering_stage_transition_id" text,
	"status" "event_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" "adjustment_reason" NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"commission_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "override_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"manager_user_id" uuid NOT NULL,
	"team_member_user_ids" uuid[] NOT NULL,
	"override_percent" numeric(5, 2) NOT NULL,
	"applies_to_plan_ids" uuid[],
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payout_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_earned" numeric(12, 2) NOT NULL,
	"total_clawed_back" numeric(12, 2) NOT NULL,
	"total_adjustments" numeric(12, 2) NOT NULL,
	"net_payable" numeric(12, 2) NOT NULL,
	"status" "statement_status" DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"event_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_assignments" ADD CONSTRAINT "plan_assignments_plan_id_commission_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."commission_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commission_configs" ADD CONSTRAINT "project_commission_configs_plan_override_id_commission_plans_id_fk" FOREIGN KEY ("plan_override_id") REFERENCES "public"."commission_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_commission_event_id_commission_events_id_fk" FOREIGN KEY ("commission_event_id") REFERENCES "public"."commission_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plans_org_id" ON "commission_plans" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plans_active_name" ON "commission_plans" USING btree ("org_id","name") WHERE "commission_plans"."is_active" = true;--> statement-breakpoint
CREATE INDEX "idx_assignments_org_id" ON "plan_assignments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_assignments_plan_user" ON "plan_assignments" USING btree ("plan_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_configs_org_id" ON "project_commission_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_events_org_id" ON "commission_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_events_dashboard" ON "commission_events" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_events_project" ON "commission_events" USING btree ("project_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_events_idempotency" ON "commission_events" USING btree ("triggering_stage_transition_id","user_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_adjustments_org_id" ON "commission_adjustments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_adjustments_project_user" ON "commission_adjustments" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_override_rules_org_id" ON "override_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_override_rules_manager" ON "override_rules" USING btree ("org_id","manager_user_id");--> statement-breakpoint
CREATE INDEX "idx_statements_org_id" ON "payout_statements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_statements_user" ON "payout_statements" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_org_id" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity" ON "audit_log" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
-- btree_gist required for the plan_assignments exclusion constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- commission_plans: effective_to must be after effective_from when set
ALTER TABLE "commission_plans" ADD CONSTRAINT "plans_effective_dates_check"
  CHECK (effective_to IS NULL OR effective_to > effective_from);--> statement-breakpoint
-- commission_events: immutable except for status
CREATE OR REPLACE FUNCTION prevent_commission_event_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.id, OLD.org_id, OLD.project_id, OLD.user_id, OLD.plan_id,
      OLD.event_type, OLD.amount, OLD.triggering_stage_transition_id,
      OLD.notes, OLD.created_at, OLD.created_by)
     IS DISTINCT FROM
     (NEW.id, NEW.org_id, NEW.project_id, NEW.user_id, NEW.plan_id,
      NEW.event_type, NEW.amount, NEW.triggering_stage_transition_id,
      NEW.notes, NEW.created_at, NEW.created_by) THEN
    RAISE EXCEPTION 'commission_events rows are immutable except for the status column';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER enforce_commission_event_immutability
  BEFORE UPDATE ON "commission_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_commission_event_update();--> statement-breakpoint
-- plan_assignments: no overlapping date ranges for the same (plan_id, user_id, role)
ALTER TABLE "plan_assignments" ADD CONSTRAINT "plan_assignments_no_overlap"
  EXCLUDE USING gist (
    plan_id WITH =,
    user_id WITH =,
    role WITH =,
    tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz), '[)') WITH &&
  );