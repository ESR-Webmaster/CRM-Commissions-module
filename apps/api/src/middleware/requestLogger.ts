import { AsyncLocalStorage } from 'node:async_hooks';
import pinoHttp from 'pino-http';
import pino from 'pino';
import type { Request, RequestHandler } from 'express';

export const requestIdStorage = new AsyncLocalStorage<string>();
export const getRequestId = (): string => requestIdStorage.getStore() ?? 'no-context';

export const rootLogger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  name: 'api',
});

export const httpLogger: RequestHandler = pinoHttp({
  logger: rootLogger,
  genReqId: () => crypto.randomUUID(),
  customProps(req: Request) {
    return {
      request_id: req.id,
      org_id: req.auth?.org_id,
      user_id: req.auth?.user_id,
    };
  },
  customLogLevel(_req, res) {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req(req) {
      return { method: req.method, url: req.url, id: req.id };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

// Express middleware that binds the request ID from pino-http into AsyncLocalStorage
export function requestIdMiddleware(
  req: Request,
  _res: unknown,
  next: () => void
): void {
  requestIdStorage.run(String(req.id ?? crypto.randomUUID()), next);
}
