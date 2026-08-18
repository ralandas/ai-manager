import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { register, login, authUser } from '../auth/auth.js';
import { savePhoto, deletePhoto, listPhotoFiles } from '../frontend/photos.js';

/**
 * Multi-tenant owner API (v2), DB-backed:
 *  - POST /api/v2/register, /api/v2/login
 *  - CRUD /api/v2/apartments (owner-scoped)
 *  - photos under an apartment (owner-scoped)
 *
 * Apartments live in our DB. rc_apartment_id optionally links a card to a
 * Realty Calendar object for booking/availability/payment.
 */
export function registerOwnerApi(app: FastifyInstance): void {
  // CORS for the whole v2 surface.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v2')) return;
    reply.header('Access-Control-Allow-Origin', config.ADMIN_CORS_ORIGIN);
    reply.header('Access-Control-Allow-Headers', 'authorization, content-type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') reply.code(204).send();
  });

  // --- auth ---
  app.post<{ Body: { email?: string; phone?: string; password: string; name?: string } }>(
    '/api/v2/register',
    async (req, reply) => {
      try {
        return await register(req.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'bad request' });
      }
    },
  );

  app.post<{ Body: { login: string; password: string } }>(
    '/api/v2/login',
    async (req, reply) => {
      try {
        return await login(req.body);
      } catch (err) {
        return reply.code(401).send({ error: err instanceof Error ? err.message : 'unauthorized' });
      }
    },
  );

  // --- apartments CRUD (owner-scoped) ---
  app.get('/api/v2/apartments', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    const rows = await sql`
      SELECT a.*, COALESCE(p.cnt, 0)::int AS photo_count
      FROM apartments a
      LEFT JOIN (SELECT apartment_id, COUNT(*) cnt FROM apartment_photos GROUP BY apartment_id) p
        ON p.apartment_id = a.id
      WHERE a.owner_id = ${uid}
      ORDER BY a.created_at`;

    if (rows.length > 0) {
      return { apartments: rows, source: 'db' };
    }

    // If DB has no apartments, check if owner has a connected PMS (Bnovo/RC)
    try {
      const userRows = await sql<{ pms_provider: string }[]>`
        SELECT pms_provider FROM users WHERE id = ${uid} LIMIT 1`;
      if (userRows[0] && userRows[0].pms_provider !== 'stub') {
        const { createPmsForOwner } = await import('../pms/for-owner.js');
        const pms = await createPmsForOwner(uid);
        const pmsProps = await pms.listProperties();
        const mapped = pmsProps.map((p) => ({
          id: p.id,
          title: p.title,
          address: p.title,
          price: p.basePrice || null,
          photo_count: 0,
          from_pms: true,
        }));
        return { apartments: mapped, source: userRows[0].pms_provider };
      }
    } catch (err) {
      logger.error({ uid, err }, 'Failed to fetch apartments from PMS fallback');
    }

    return { apartments: [], source: 'db' };
  });

  // --- Sync apartments from PMS into our database ---
  app.post('/api/v2/apartments/sync', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    try {
      const { createPmsForOwner } = await import('../pms/for-owner.js');
      const pms = await createPmsForOwner(uid);
      const props = await pms.listProperties();

      let syncedCount = 0;
      for (const p of props) {
        // Upsert by title or link
        const existing = await sql`
          SELECT id FROM apartments WHERE owner_id = ${uid} AND (rc_apartment_id = ${p.id} OR title = ${p.title}) LIMIT 1`;
        if (existing.length === 0) {
          await sql`
            INSERT INTO apartments (owner_id, title, address, price, rc_apartment_id)
            VALUES (${uid}, ${p.title}, ${p.title}, ${p.basePrice || null}, ${p.id})`;
          syncedCount++;
        }
      }

      logger.info({ uid, count: syncedCount }, 'Apartments synced from PMS');
      return { ok: true, synced_count: syncedCount, total_count: props.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      return reply.code(400).send({ error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/v2/apartments/:id', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    const rows = await sql`
      SELECT * FROM apartments WHERE id = ${req.params.id} AND owner_id = ${uid} LIMIT 1`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const photos = listPhotoFiles(req.params.id);
    return { apartment: rows[0], photos };
  });

  app.post<{ Body: ApartmentBody }>('/api/v2/apartments', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    const b = req.body ?? ({} as ApartmentBody);
    if (!b.title?.trim()) return reply.code(400).send({ error: 'Нужно название' });
    const rows = await sql`
      INSERT INTO apartments
        (owner_id, title, address, price, rules, checkin_instructions,
         wifi_name, wifi_password, extra, rc_apartment_id)
      VALUES
        (${uid}, ${b.title}, ${b.address ?? null}, ${b.price ?? null}, ${b.rules ?? null},
         ${b.checkinInstructions ?? null}, ${b.wifiName ?? null}, ${b.wifiPassword ?? null},
         ${b.extra ?? null}, ${b.rcApartmentId ?? null})
      RETURNING *`;
    return { apartment: rows[0] };
  });

  app.put<{ Params: { id: string }; Body: ApartmentBody }>(
    '/api/v2/apartments/:id',
    async (req, reply) => {
      const uid = authUser(req, reply);
      if (!uid) return;
      const b = req.body ?? ({} as ApartmentBody);
      const rows = await sql`
        UPDATE apartments SET
          title = COALESCE(${b.title ?? null}, title),
          address = ${b.address ?? null},
          price = ${b.price ?? null},
          rules = ${b.rules ?? null},
          checkin_instructions = ${b.checkinInstructions ?? null},
          wifi_name = ${b.wifiName ?? null},
          wifi_password = ${b.wifiPassword ?? null},
          extra = ${b.extra ?? null},
          rc_apartment_id = ${b.rcApartmentId ?? null},
          updated_at = now()
        WHERE id = ${req.params.id} AND owner_id = ${uid}
        RETURNING *`;
      if (!rows.length) return reply.code(404).send({ error: 'not found' });
      return { apartment: rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v2/apartments/:id', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    const rows = await sql`
      DELETE FROM apartments WHERE id = ${req.params.id} AND owner_id = ${uid} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // --- photos (owner-scoped via ownership check) ---
  const ownsApartment = async (uid: string, id: string): Promise<boolean> => {
    const r = await sql`SELECT 1 FROM apartments WHERE id = ${id} AND owner_id = ${uid} LIMIT 1`;
    return r.length > 0;
  };

  app.post<{ Params: { id: string } }>('/api/v2/apartments/:id/photos', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    if (!(await ownsApartment(uid, req.params.id)))
      return reply.code(404).send({ error: 'not found' });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const buf = await file.toBuffer();
    try {
      const name = savePhoto(req.params.id, buf, file.filename);
      await sql`INSERT INTO apartment_photos (apartment_id, file_name) VALUES (${req.params.id}, ${name})`;
      return { ok: true, photos: listPhotoFiles(req.params.id) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'bad file' });
    }
  });

  app.delete<{ Params: { id: string; file: string } }>(
    '/api/v2/apartments/:id/photos/:file',
    async (req, reply) => {
      const uid = authUser(req, reply);
      if (!uid) return;
      if (!(await ownsApartment(uid, req.params.id)))
        return reply.code(404).send({ error: 'not found' });
      const ok = deletePhoto(req.params.id, req.params.file);
      await sql`DELETE FROM apartment_photos WHERE apartment_id = ${req.params.id} AND file_name = ${req.params.file}`;
      return { ok, photos: listPhotoFiles(req.params.id) };
    },
  );
}

interface ApartmentBody {
  title?: string;
  address?: string;
  price?: number;
  rules?: string;
  checkinInstructions?: string;
  wifiName?: string;
  wifiPassword?: string;
  extra?: string;
  rcApartmentId?: string;
}
