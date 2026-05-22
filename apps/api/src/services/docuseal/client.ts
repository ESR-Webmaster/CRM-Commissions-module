import pino from 'pino';
import type {
  DocusealTemplate,
  DocusealSubmission,
  CreateSubmissionInput,
} from './types';
import { DocusealError, classifyHttpError } from './errors';
import { docusealApiLatencyMs, docusealApiErrorsTotal } from './metrics';

const logger = pino({ name: 'docuseal-client' });

// ── Interface ─────────────────────────────────────────────────────────────────

export interface DocusealClient {
  listTemplates(): Promise<DocusealTemplate[]>;
  getTemplate(id: string): Promise<DocusealTemplate>;
  createSubmission(input: CreateSubmissionInput): Promise<DocusealSubmission>;
  getSubmission(id: string): Promise<DocusealSubmission>;
  voidSubmission(id: string, reason: string): Promise<void>;
  resendSubmission(id: string): Promise<void>;
  getSigningUrl(submissionId: string, submitterId: string): Promise<string>;
  downloadSignedPdf(submissionId: string): Promise<Buffer>;
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
}

// ── SaaS implementation ───────────────────────────────────────────────────────

const SAAS_BASE = 'https://api.docuseal.com';
const MAX_RETRIES = 3;

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 2) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export class DocusealSaasClient implements DocusealClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly orgId: string;

  constructor(opts: { apiToken: string; orgId: string; baseUrl?: string }) {
    this.token = opts.apiToken;
    this.orgId = opts.orgId;
    this.baseUrl = opts.baseUrl ?? SAAS_BASE;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    operation = path
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const start = Date.now();
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;
      let response: Response;

      try {
        const init: RequestInit = {
          method,
          headers: {
            'X-Auth-Token': this.token,
            'Content-Type': 'application/json',
            'X-Org-Id': this.orgId,
          },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        response = await fetch(url, init);
      } catch (err) {
        const latency = Date.now() - start;
        docusealApiErrorsTotal.inc({ operation, category: 'network' });
        logger.warn({ operation, attempt, latencyMs: latency, err }, 'DocuSeal network error');

        if (attempt >= MAX_RETRIES) {
          throw new DocusealError('network', `Network error calling DocuSeal: ${String(err)}`);
        }
        await sleep(exponentialBackoff(attempt));
        continue;
      }

      const latency = Date.now() - start;
      docusealApiLatencyMs.observe({ operation }, latency);

      if (response.status === 429 && attempt < MAX_RETRIES) {
        docusealApiErrorsTotal.inc({ operation, category: 'rate_limit' });
        logger.warn({ operation, attempt }, 'DocuSeal rate limited, retrying');
        await sleep(exponentialBackoff(attempt));
        continue;
      }

      if (!response.ok) {
        const category = classifyHttpError(response.status);
        docusealApiErrorsTotal.inc({ operation, category });
        let detail = '';
        try {
          const body = await response.json();
          detail = JSON.stringify(body);
        } catch {
          // ignore parse error
        }
        logger.warn({ operation, status: response.status, orgId: this.orgId }, 'DocuSeal API error');
        throw new DocusealError(
          category,
          `DocuSeal ${method} ${path} failed with ${response.status}: ${detail}`,
          response.status
        );
      }

      // 204 No Content
      if (response.status === 204) return undefined as T;

      return response.json() as Promise<T>;
    }

    throw new DocusealError('rate_limit', `DocuSeal rate limit exhausted after ${MAX_RETRIES} retries`);
  }

  async listTemplates(): Promise<DocusealTemplate[]> {
    return this.request<DocusealTemplate[]>('GET', '/templates', undefined, 'listTemplates');
  }

  async getTemplate(id: string): Promise<DocusealTemplate> {
    return this.request<DocusealTemplate>('GET', `/templates/${id}`, undefined, 'getTemplate');
  }

  async createSubmission(input: CreateSubmissionInput): Promise<DocusealSubmission> {
    // Redact PII from the log; never log raw emails
    const redacted = {
      ...input,
      submitters: input.submitters.map((s) => ({
        ...s,
        email: redactEmail(s.email),
        phone: s.phone ? '***' : undefined,
      })),
    };
    logger.info({ operation: 'createSubmission', orgId: this.orgId, input: redacted }, 'Creating submission');
    return this.request<DocusealSubmission>('POST', '/submissions', input, 'createSubmission');
  }

  async getSubmission(id: string): Promise<DocusealSubmission> {
    return this.request<DocusealSubmission>('GET', `/submissions/${id}`, undefined, 'getSubmission');
  }

  async voidSubmission(id: string, reason: string): Promise<void> {
    await this.request<void>('DELETE', `/submissions/${id}`, { reason }, 'voidSubmission');
  }

  async resendSubmission(id: string): Promise<void> {
    await this.request<void>('POST', `/submissions/${id}/send_reminder`, undefined, 'resendSubmission');
  }

  async getSigningUrl(submissionId: string, submitterId: string): Promise<string> {
    const result = await this.request<{ embed_src: string }>(
      'GET',
      `/submissions/${submissionId}/submitters/${submitterId}`,
      undefined,
      'getSigningUrl'
    );
    return result.embed_src;
  }

  async downloadSignedPdf(submissionId: string): Promise<Buffer> {
    const url = `${this.baseUrl}/submissions/${submissionId}/combined_document`;
    const start = Date.now();

    const response = await fetch(url, {
      headers: { 'X-Auth-Token': this.token },
    });

    docusealApiLatencyMs.observe({ operation: 'downloadSignedPdf' }, Date.now() - start);

    if (!response.ok) {
      const category = classifyHttpError(response.status);
      docusealApiErrorsTotal.inc({ operation: 'downloadSignedPdf', category });
      throw new DocusealError(
        category,
        `Failed to download signed PDF for submission ${submissionId}: ${response.status}`,
        response.status
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.request<DocusealTemplate[]>('GET', '/templates?limit=1', undefined, 'ping');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDocusealClient(opts: {
  apiToken: string;
  orgId: string;
  mode: 'saas' | 'self_hosted';
  endpointUrl: string;
}): DocusealClient {
  return new DocusealSaasClient({
    apiToken: opts.apiToken,
    orgId: opts.orgId,
    baseUrl: opts.mode === 'saas' ? SAAS_BASE : opts.endpointUrl,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exponentialBackoff(attempt: number): number {
  return Math.min(200 * Math.pow(2, attempt - 1), 5000);
}
