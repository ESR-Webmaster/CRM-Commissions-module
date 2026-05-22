ALTER TABLE "commission_events" ADD COLUMN "delivery_id" text;

-- Replace immutability trigger to also protect delivery_id
CREATE OR REPLACE FUNCTION prevent_commission_event_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.id, OLD.org_id, OLD.project_id, OLD.user_id, OLD.plan_id,
      OLD.event_type, OLD.amount, OLD.triggering_stage_transition_id,
      OLD.delivery_id, OLD.notes, OLD.created_at, OLD.created_by)
     IS DISTINCT FROM
     (NEW.id, NEW.org_id, NEW.project_id, NEW.user_id, NEW.plan_id,
      NEW.event_type, NEW.amount, NEW.triggering_stage_transition_id,
      NEW.delivery_id, NEW.notes, NEW.created_at, NEW.created_by) THEN
    RAISE EXCEPTION 'commission_events rows are immutable except for the status column';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;