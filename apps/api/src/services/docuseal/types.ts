// Types mirroring DocuSeal's API response shapes.
// Defined here rather than importing an SDK to keep the integration thin.

export type DocusealEventType =
  | 'submission.sent'
  | 'submission.viewed'
  | 'submission.signed_by_party'
  | 'submission.completed'
  | 'submission.declined'
  | 'submission.expired';

export interface DocusealSignerRoleSpec {
  name: string;
}

export interface DocusealTemplate {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  slug?: string;
  submitters?: DocusealSignerRoleSpec[];
  fields?: Array<{ name: string; type: string }>;
}

export interface DocusealSubmitter {
  id: string;
  submission_id: string;
  uuid: string;
  email: string;
  phone?: string;
  name?: string;
  status: 'sent' | 'opened' | 'completed' | 'declined';
  signed_at?: string;
  opened_at?: string;
  created_at: string;
  updated_at: string;
  role: string;
  embed_src?: string;
}

export interface DocusealSubmission {
  id: string;
  template_id: string;
  status: 'pending' | 'completed' | 'declined' | 'expired';
  created_at: string;
  updated_at: string;
  audit_log_url?: string;
  combined_document_url?: string;
  submitters: DocusealSubmitter[];
}

export interface CreateSubmissionSubmitter {
  role: string;
  name: string;
  email: string;
  phone?: string;
  send_email?: boolean;
  send_sms?: boolean;
  values?: Record<string, string>;
}

export interface CreateSubmissionInput {
  template_id: string;
  submitters: CreateSubmissionSubmitter[];
  message?: {
    subject?: string;
    body?: string;
  };
  send_email?: boolean;
  send_sms?: boolean;
  expire_at?: string;
}
