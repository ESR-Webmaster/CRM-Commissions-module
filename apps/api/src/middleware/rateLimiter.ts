import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
}

export function createRateLimiter(opts: RateLimiterOptions = {}) {
  return rateLimit({
    windowMs: opts.windowMs ?? 1000,
    max: opts.max ?? 100,
    keyGenerator: (req: Request) => req.auth?.org_id ?? 'unauthenticated',
    skip: () => false,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      res.setHeader('Retry-After', '1');
      res.status(429).json({ error: 'rate_limit_exceeded' });
    },
  });
}
