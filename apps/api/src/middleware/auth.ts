import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { orgs } from '../db/schema/orgs';
import pino from 'pino';

const logger = pino({ name: 'auth' });

interface JwtClaims {
  org_id: string;
  user_id: string;
  role: string;
}

function isJwtClaims(payload: unknown): payload is JwtClaims {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p['org_id'] === 'string' && typeof p['user_id'] === 'string' && typeof p['role'] === 'string';
}

export function createAuthMiddleware(db: Db, signingKey?: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = crypto.randomUUID();
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.info({ requestId, reason: 'missing_token' }, 'Auth failed');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = authHeader.slice(7);
    const key = signingKey ?? process.env['JWT_SIGNING_KEY'];

    if (!key) {
      logger.error('JWT_SIGNING_KEY not configured');
      res.status(500).json({ error: 'server_configuration_error' });
      return;
    }

    let payload: JwtClaims;
    try {
      const decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
      if (!isJwtClaims(decoded)) {
        throw new Error('missing required claims');
      }
      payload = decoded;
    } catch (err) {
      logger.info({ requestId, reason: err instanceof Error ? err.message : 'unknown' }, 'Auth failed: invalid token');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, payload.org_id)).limit(1);

    if (!org) {
      logger.info({ requestId, orgId: payload.org_id }, 'Auth failed: org not found');
      res.status(403).json({ error: 'org_not_found' });
      return;
    }

    req.auth = {
      org_id: payload.org_id,
      user_id: payload.user_id,
      role: payload.role,
    };

    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
