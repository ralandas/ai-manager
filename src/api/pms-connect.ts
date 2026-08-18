import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { authUser } from '../auth/auth.js';
import { logger } from '../logger.js';
import { invalidateOwnerPms, createPmsForOwner } from '../pms/for-owner.js';

/**
 * PMS connection API:
 *  - POST   /api/v2/pms/connect     — save provider + credentials
 *  - POST   /api/v2/pms/test        — try listProperties() with given creds
 *  - DELETE /api/v2/pms/disconnect   — reset to stub
 */
export function registerPmsConnectApi(app: FastifyInstance): void {
  // --- Connect (save credentials) ---
  app.post<{
    Body: { provider: string; credentials: Record<string, unknown> };
  }>('/api/v2/pms/connect', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const { provider, credentials } = req.body ?? {};
    if (!provider || !['bnovo', 'realtycalendar'].includes(provider)) {
      return reply.code(400).send({ error: 'provider must be "bnovo" or "realtycalendar"' });
    }
    if (!credentials || typeof credentials !== 'object') {
      return reply.code(400).send({ error: 'credentials object required' });
    }

    await sql`
      UPDATE users SET
        pms_provider = ${provider},
        pms_credentials = ${JSON.stringify(credentials)}::jsonb
      WHERE id = ${uid}`;

    // Invalidate cached PMS connector so next agent call picks up the new creds.
    invalidateOwnerPms(uid);

    logger.info({ uid, provider }, 'PMS connected');
    return { ok: true, provider };
  });

  // --- Test (try connecting with given or stored creds) ---
  app.post<{
    Body?: { provider?: string; credentials?: Record<string, unknown> };
  }>('/api/v2/pms/test', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    try {
      const b = req.body ?? {};

      // If creds are provided in the body, temporarily save them for the test,
      // then revert. If not provided, test with what's already stored.
      if (b.provider && b.credentials) {
        // Save temporarily
        await sql`
          UPDATE users SET
            pms_provider = ${b.provider},
            pms_credentials = ${JSON.stringify(b.credentials)}::jsonb
          WHERE id = ${uid}`;
        invalidateOwnerPms(uid);
      }

      const pms = await createPmsForOwner(uid);
      const properties = await pms.listProperties();

      return {
        ok: true,
        properties_count: properties.length,
        properties: properties.slice(0, 5).map((p) => ({
          id: p.id,
          title: p.title,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PMS test failed';
      logger.error({ uid, err }, 'PMS test failed');
      return reply.code(400).send({ error: message });
    }
  });

  // --- Disconnect ---
  app.delete('/api/v2/pms/disconnect', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    await sql`
      UPDATE users SET
        pms_provider = 'stub',
        pms_credentials = '{}'::jsonb
      WHERE id = ${uid}`;

    invalidateOwnerPms(uid);
    logger.info({ uid }, 'PMS disconnected');
    return { ok: true };
  });
}
