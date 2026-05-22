import { Router } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { orgs } from '../db/schema/orgs';

export function createDevTokenRouter(db: Db, signingKey: string): Router {
  const router = Router();

  // POST /dev/token — dev-only, unauthenticated
  // Returns a fresh signed JWT for the first org in the DB.
  // Blocked entirely in production.
  router.post('/', async (req, res): Promise<void> => {
    const role = req.body?.role === 'rep' ? 'rep' : 'admin';

    let [org] = await db
      .select({ id: orgs.id, name: orgs.name })
      .from(orgs)
      .limit(1);

    if (!org) {
      const [created] = await db
        .insert(orgs)
        .values({ id: randomUUID(), name: 'Dev Org', settings: { require_event_approval: false } })
        .returning({ id: orgs.id, name: orgs.name });
      org = created;
    }

    if (!org) {
      res.status(500).json({ error: 'could_not_create_org' });
      return;
    }

    const userId = randomUUID();
    const token = jwt.sign(
      { org_id: org.id, user_id: userId, role },
      signingKey,
      { algorithm: 'HS256', expiresIn: '24h' },
    );

    res.json({ token, org_id: org.id, user_id: userId, role });
  });

  return router;
}
