import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PmsConnector } from '../pms/types.js';
import {
  getAllApartmentInfo,
  getApartmentInfo,
  saveApartmentInfo,
  type ApartmentInfo,
} from './apartments-info.js';
import { listPhotoFiles, savePhoto, deletePhoto } from './photos.js';

/**
 * Admin API for the apartment-info editor (hosted on Vercel). The owner logs in
 * with ADMIN_TOKEN, sees their real RC apartments, and fills in per-apartment
 * rules / self-check-in / wifi. Data is persisted to apartments-info.json and
 * served to guests by the agent.
 *
 * CORS is enabled so the Vercel front (different origin) can call it.
 */
export function registerAdminApi(app: FastifyInstance, pms: PmsConnector): void {
  const origin = config.ADMIN_CORS_ORIGIN;

  // CORS preflight + headers for everything under /api/admin.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/admin')) return;
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Headers', 'authorization, content-type');
    reply.header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.ADMIN_TOKEN) {
      reply.code(503).send({ error: 'ADMIN_TOKEN not configured on server' });
      return false;
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token !== config.ADMIN_TOKEN) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  };

  // Login = validate the token (front stores it and sends it as Bearer).
  app.post<{ Body: { token?: string } }>('/api/admin/login', async (req, reply) => {
    if (!config.ADMIN_TOKEN) return reply.code(503).send({ error: 'ADMIN_TOKEN not configured' });
    if (req.body?.token !== config.ADMIN_TOKEN) return reply.code(401).send({ ok: false });
    return { ok: true };
  });

  // List apartments from RC, merged with any saved info (so the owner sees all
  // real objects and which ones still need filling in).
  app.get('/api/admin/apartments', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    let properties: Array<{ id: string; title: string }> = [];
    try {
      properties = (await pms.listProperties()).map((p) => ({ id: p.id, title: p.title }));
    } catch (err) {
      logger.error({ err }, 'admin: listProperties failed');
    }
    const info = getAllApartmentInfo();
    // Union of RC ids and any info-only ids.
    const ids = new Set<string>([...properties.map((p) => p.id), ...Object.keys(info)]);
    const items = [...ids].map((id) => {
      const rc = properties.find((p) => p.id === id);
      const saved = info[id];
      return {
        id,
        title: saved?.title ?? rc?.title ?? id,
        filled: Boolean(saved?.checkinInstructions || saved?.rules),
      };
    });
    return { apartments: items };
  });

  // Full info for one apartment (to prefill the edit form).
  app.get<{ Params: { id: string } }>('/api/admin/apartments/:id', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const saved = getApartmentInfo(req.params.id);
    let title = saved?.title;
    if (!title) {
      try {
        title = (await pms.listProperties()).find((p) => p.id === req.params.id)?.title;
      } catch {
        /* ignore */
      }
    }
    const info: ApartmentInfo = saved ?? { id: req.params.id, title: title ?? req.params.id };
    return { info: { ...info, title: info.title ?? title ?? req.params.id } };
  });

  // Save edits.
  app.put<{ Params: { id: string }; Body: Partial<ApartmentInfo> }>(
    '/api/admin/apartments/:id',
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const body = req.body ?? {};
      const saved = saveApartmentInfo({
        id: req.params.id,
        title: body.title ?? getApartmentInfo(req.params.id)?.title ?? req.params.id,
        address: body.address,
        rules: body.rules,
        checkinInstructions: body.checkinInstructions,
        wifi: body.wifi,
        extra: body.extra,
      });
      return { ok: true, info: saved };
    },
  );

  // --- photos ---

  // List current photo file names for an apartment.
  app.get<{ Params: { id: string } }>('/api/admin/apartments/:id/photos', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return { photos: listPhotoFiles(req.params.id) };
  });

  // Upload one photo (multipart form field "file").
  app.post<{ Params: { id: string } }>(
    '/api/admin/apartments/:id/photos',
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'no file' });
      const buf = await file.toBuffer();
      try {
        const name = savePhoto(req.params.id, buf, file.filename);
        return { ok: true, file: name, photos: listPhotoFiles(req.params.id) };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'bad file' });
      }
    },
  );

  // Delete a photo by file name.
  app.delete<{ Params: { id: string; file: string } }>(
    '/api/admin/apartments/:id/photos/:file',
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const ok = deletePhoto(req.params.id, req.params.file);
      return { ok, photos: listPhotoFiles(req.params.id) };
    },
  );
}
