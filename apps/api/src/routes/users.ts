import { Router } from 'express';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { users } from '../db/schema/users';
import { requireAdmin } from '../middleware/auth';

const syncBodySchema = z.object({
  users: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      email: z.string().email(),
      role: z.string().min(1),
    })
  ).min(1),
});

export function createUsersRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireAdmin, async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.orgId, req.auth.org_id))
      .orderBy(users.name);
    res.json({ users: rows, total: rows.length });
  });

  router.post('/sync', requireAdmin, async (req, res): Promise<void> => {
    const parsed = syncBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const now = new Date();
    const rows = parsed.data.users.map((u) => ({
      id: u.id,
      orgId: req.auth.org_id,
      name: u.name,
      email: u.email,
      role: u.role,
      updatedAt: now,
    }));

    await db
      .insert(users)
      .values(rows)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          name: sql`excluded.name`,
          email: sql`excluded.email`,
          role: sql`excluded.role`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    res.json({ synced: rows.length });
  });

  return router;
}
