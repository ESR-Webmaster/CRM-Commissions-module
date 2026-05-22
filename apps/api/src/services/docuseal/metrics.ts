import { Counter, Histogram } from 'prom-client';
import { registry } from '../../lib/metrics';

export const docusealApiLatencyMs = new Histogram({
  name: 'docuseal_api_latency_ms',
  help: 'DocuSeal API call duration in milliseconds',
  labelNames: ['operation'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const docusealApiErrorsTotal = new Counter({
  name: 'docuseal_api_errors_total',
  help: 'DocuSeal API errors',
  labelNames: ['operation', 'category'] as const,
  registers: [registry],
});

export const docusealWebhooksTotal = new Counter({
  name: 'docuseal_webhooks_total',
  help: 'Inbound DocuSeal webhooks',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

export const docusealWebhookInvalidSignatureTotal = new Counter({
  name: 'docuseal_webhook_invalid_signature_total',
  help: 'DocuSeal webhooks rejected due to invalid HMAC signature',
  registers: [registry],
});

export const docusealWebhookDuplicateTotal = new Counter({
  name: 'docuseal_webhook_duplicate_total',
  help: 'DocuSeal webhooks skipped as duplicates',
  registers: [registry],
});

export const docusealWebhookLatencyMs = new Histogram({
  name: 'docuseal_webhook_processing_latency_ms',
  help: 'DocuSeal webhook handler latency in milliseconds',
  buckets: [10, 25, 50, 100, 200, 500],
  registers: [registry],
});

export const docusealSubmissionsCreatedTotal = new Counter({
  name: 'docuseal_submissions_created_total',
  help: 'DocuSeal submissions created',
  labelNames: ['template_category'] as const,
  registers: [registry],
});

export const docusealSubmissionsCompletedTotal = new Counter({
  name: 'docuseal_submissions_completed_total',
  help: 'DocuSeal submissions completed (all parties signed)',
  registers: [registry],
});

export const docusealSubmissionsDeclinedTotal = new Counter({
  name: 'docuseal_submissions_declined_total',
  help: 'DocuSeal submissions declined by a signer',
  registers: [registry],
});

export const docusealReconciliationDriftTotal = new Counter({
  name: 'docuseal_reconciliation_drift_total',
  help: 'Submissions found out-of-sync during reconciliation',
  registers: [registry],
});
