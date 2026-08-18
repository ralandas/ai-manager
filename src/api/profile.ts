import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { authUser } from '../auth/auth.js';

/**
 * Owner profile API:
 *  - GET  /api/v2/me  — current user profile + connection statuses
 *  - PUT  /api/v2/me  — update name / email / phone
 */
export function registerProfileApi(app: FastifyInstance): void {
  app.get('/api/v2/me', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const rows = await sql<{
      id: string;
      email: string | null;
      phone: string | null;
      name: string | null;
      pms_provider: string;
      pms_credentials: Record<string, unknown>;
      tg_config: Record<string, unknown>;
      agent_config: Record<string, unknown>;
      tg_connected: boolean;
      agent_running: boolean;
      created_at: string;
    }[]>`
      SELECT id, email, phone, name, pms_provider, pms_credentials,
             tg_config, agent_config, tg_connected, agent_running, created_at
      FROM users WHERE id = ${uid} LIMIT 1`;

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'user not found' });

    // Strip secrets from the response — only expose whether they're set.
    const pmsCreds = row.pms_credentials ?? {};
    const tgConfig = row.tg_config ?? {};

    return {
      user: {
        id: row.id,
        email: row.email,
        phone: row.phone,
        name: row.name,
        created_at: row.created_at,
        pms_provider: row.pms_provider,
        pms_connected: row.pms_provider !== 'stub',
        pms_has_credentials: Object.keys(pmsCreds).length > 0,
        tg_connected: row.tg_connected,
        tg_has_config: Object.keys(tgConfig).length > 0,
        tg_username: (tgConfig as { username?: string }).username ?? null,
        agent_running: row.agent_running,
        agent_config: row.agent_config,
      },
    };
  });

  app.put<{ Body: { name?: string; email?: string; phone?: string } }>(
    '/api/v2/me',
    async (req, reply) => {
      const uid = authUser(req, reply);
      if (!uid) return;

      const b = req.body ?? {};
      const sets: string[] = [];

      // Build dynamic SET clause but keep it safe with parameterized queries.
      const rows = await sql`
        UPDATE users SET
          name  = COALESCE(${b.name ?? null}, name),
          email = COALESCE(${b.email ?? null}, email),
          phone = COALESCE(${b.phone ?? null}, phone)
        WHERE id = ${uid}
        RETURNING id, email, phone, name`;

      if (!rows.length) return reply.code(404).send({ error: 'user not found' });
      return { user: rows[0] };
    },
  );
}
