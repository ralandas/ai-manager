import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getApartmentInfo, type ApartmentInfo } from './apartments-info.js';

/** Public URL of an apartment's info page (shared with guests in chat). */
export function apartmentPageUrl(id: string): string {
  const base = config.PUBLIC_URL?.replace(/\/$/, '') ?? `http://localhost:${config.PORT}`;
  return `${base}/apt/${id}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

function renderPage(info: ApartmentInfo): string {
  const section = (title: string, body: string) =>
    body?.trim() ? `<section><h2>${esc(title)}</h2><p>${nl2br(body)}</p></section>` : '';

  const wifi =
    info.wifi?.name || info.wifi?.password
      ? `<section><h2>Wi‑Fi</h2><p>Сеть: <b>${esc(info.wifi?.name ?? '')}</b><br>Пароль: <b>${esc(
          info.wifi?.password ?? '',
        )}</b></p></section>`
      : '';

  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    background: #f5f6f8; color: #1a1a1a; line-height: 1.55; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e8e8e8; } section { background: #21242a !important; } }
  .wrap { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
  header h1 { font-size: 1.5rem; margin: 0 0 4px; }
  header .addr { color: #888; font-size: .95rem; }
  section { background: #fff; border-radius: 14px; padding: 16px 18px; margin: 14px 0;
    box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  section h2 { font-size: 1.05rem; margin: 0 0 8px; }
  section p { margin: 0; }
  footer { text-align: center; color: #aaa; font-size: .8rem; margin-top: 28px; }
</style></head>
<body><div class="wrap">
  <header><h1>${esc(info.title)}</h1>${info.address ? `<div class="addr">${esc(info.address)}</div>` : ''}</header>
  ${section('Как заселиться', info.checkinInstructions ?? '')}
  ${section('Правила проживания', info.rules ?? '')}
  ${wifi}
  ${section('Дополнительно', info.extra ?? '')}
  <footer>Заезд после 14:00 · Выезд до 12:00</footer>
</div></body></html>`;
}

export function registerFrontend(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>('/apt/:id', async (req, reply) => {
    const info = getApartmentInfo(req.params.id);
    if (!info) {
      reply.code(404).type('text/html').send('<h1>Квартира не найдена</h1>');
      return;
    }
    reply.type('text/html').send(renderPage(info));
  });
}
