import { Router } from 'express';
import type { Db } from '../db/index';
import { stageTransitionSchema } from '@sunscape/commissions-shared';
import { processStageTransition } from '../services/commissionEngine';
import { rootLogger } from '../middleware/requestLogger';

export function createWebhooksRouter(db: Db): Router {
  const router = Router();

  // ── POST /api/v1/webhooks/stage-transition ──────────────────────────────────

  router.post('/stage-transition', async (req, res): Promise<void> => {
    const parsed = stageTransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    const logger = rootLogger.child({ name: 'webhook' });

    try {
      const result = await processStageTransition(
        {
          org_id: req.auth.org_id,
          project_id: input.project_id,
          from_stage: input.from_stage,
          to_stage: input.to_stage,
          transition_id: input.transition_id,
          delivery_id: input.delivery_id ?? input.transition_id,
          occurred_at: input.occurred_at ? new Date(input.occurred_at) : new Date(),
        },
        db,
        logger
      );

      res.json({
        events_created: result.events_created.length,
        events_already_existed: result.events_already_existed.length,
        event_ids: [
          ...result.events_created.map((e) => e.id),
          ...result.events_already_existed.map((e) => e.id),
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'stage transition failed');
      res.status(422).json({ error: 'transition_failed', message });
    }
  });

  return router;
}
