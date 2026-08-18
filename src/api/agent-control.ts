import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { authUser } from '../auth/auth.js';
import { logger } from '../logger.js';

/**
 * Agent control API:
 *  - GET  /api/v2/agent/status  — is the agent running for this owner?
 *  - POST /api/v2/agent/start   — mark as running (actual process management is manual for now)
 *  - POST /api/v2/agent/stop    — mark as stopped
 *
 * NOTE: Currently, each owner's agent runs as a separate pm2 process. These
 * endpoints update the DB flag so the cabinet can display status. Full dynamic
 * agent lifecycle management (spawn/kill from API) is a future enhancement.
 */
export function registerAgentControlApi(app: FastifyInstance): void {
  app.get('/api/v2/agent/status', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const rows = await sql<{
      agent_running: boolean;
      agent_config: Record<string, unknown>;
      pms_provider: string;
      tg_connected: boolean;
    }[]>`
      SELECT agent_running, agent_config, pms_provider, tg_connected
      FROM users WHERE id = ${uid} LIMIT 1`;

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'user not found' });

    return {
      running: row.agent_running,
      config: row.agent_config,
      ready: row.pms_provider !== 'stub' && row.tg_connected,
      pms_connected: row.pms_provider !== 'stub',
      tg_connected: row.tg_connected,
    };
  });

  app.post<{ Body?: { config?: Record<string, unknown> } }>(
    '/api/v2/agent/start',
    async (req, reply) => {
      const uid = authUser(req, reply);
      if (!uid) return;

      // Check prerequisites.
      const rows = await sql<{
        pms_provider: string;
        tg_connected: boolean;
      }[]>`SELECT pms_provider, tg_connected FROM users WHERE id = ${uid} LIMIT 1`;

      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'user not found' });

      if (row.pms_provider === 'stub') {
        return reply.code(400).send({
          error: 'PMS not connected. Connect Bnovo or RealtyCalendar first.',
        });
      }
      if (!row.tg_connected) {
        return reply.code(400).send({
          error: 'Telegram not connected. Connect a Telegram account first.',
        });
      }

      const agentConfig = req.body?.config ?? {};
      await sql`
        UPDATE users SET
          agent_running = true,
          agent_config = ${JSON.stringify(agentConfig)}::jsonb
        WHERE id = ${uid}`;

      logger.info({ uid }, 'Agent marked as running');
      return { ok: true, running: true };
    },
  );

  app.post('/api/v2/agent/stop', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    await sql`UPDATE users SET agent_running = false WHERE id = ${uid}`;

    logger.info({ uid }, 'Agent marked as stopped');
    return { ok: true, running: false };
  });
}
