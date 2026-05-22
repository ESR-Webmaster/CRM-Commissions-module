export type DocusealErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'not_found'
  | 'server_error'
  | 'network';

export class DocusealError extends Error {
  constructor(
    public readonly category: DocusealErrorCategory,
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'DocusealError';
  }
}

export function classifyHttpError(status: number): DocusealErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}
