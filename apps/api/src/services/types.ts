import type { CommissionEvent } from '@sunscape/commissions-shared';

export type CommissionEventRow = CommissionEvent;

export type StageTransitionInput = {
  org_id: string;
  project_id: string;
  from_stage: string;
  to_stage: string;
  transition_id: string;
  delivery_id: string;
  occurred_at: Date;
};

export type EngineResult = {
  events_created: CommissionEventRow[];
  events_already_existed: CommissionEventRow[];
};

export type PreviewInput = {
  org_id: string;
  project_id: string;
  hypothetical_stage: string;
};

export type PreviewResult = {
  would_create: Array<{
    user_id: string;
    plan_id: string;
    event_type: 'earned' | 'override_earned';
    amount: number;
    calculation_explanation: string;
  }>;
};

export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}
