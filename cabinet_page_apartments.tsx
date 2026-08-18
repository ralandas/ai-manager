'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { listApartments, deleteApartment, type Apartment } from '@/lib/api';
import Link from 'next/link';

export default function ApartmentsPage() {
  const { token, user } = useAuth();
  const [items, setItems] = useState<Apartment[] | null>(null);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const load = () => {
    if (!token) return;
    listApartments(token)
      .then(setItems)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSync = async () => {
    if (!token) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch('/api/v2/apartments/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка синхронизации');
      setSyncMsg(`Синхронизировано: ${data.synced_count} из ${data.total_count} квартир`);
      load();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (id: string, title: string) => {
    if (!token || !confirm(`Удалить «${title}»? Это действие необратимо.`)) return;
    await deleteApartment(token, id);
    load();
  };

  const hasPmsItems = items?.some((i) => (i as { from_pms?: boolean }).from_pms);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1>🏠 Квартиры ({items?.length ?? '...'})</h1>
          <p className="subtitle">
            {user?.pms_connected
              ? `Интеграция с ${user.pms_provider === 'bnovo' ? 'Bnovo' : 'RealtyCalendar'} активна`
              : 'Добавляйте квартиры, заполняйте правила, заселение и фото'}
          </p>
        </div>
        <div className="flex gap-2">
          {user?.pms_connected && (
            <button
              onClick={handleSync}
              className="btn btn-secondary"
              disabled={syncing}
            >
              {syncing ? <><span className="spinner" /> Синхронизирую...</> : '🔄 Импорт из PMS'}
            </button>
          )}
          <Link href="/apartments/new" className="btn btn-primary">
            + Добавить вручную
          </Link>
        </div>
      </div>

      {syncMsg && (
        <div className="card mb-4" style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', padding: '12px 16px' }}>
          <p style={{ color: 'var(--success)', fontWeight: 600, fontSize: '0.9rem' }}>
            ✓ {syncMsg}
          </p>
        </div>
      )}

      {hasPmsItems && (
        <div className="card mb-4" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--border-accent)', padding: '12px 16px' }}>
          <p style={{ color: 'var(--accent-hover)', fontWeight: 500, fontSize: '0.88rem' }}>
            ✨ Подтянуто {items?.length} квартир с фотографиями из {user?.pms_provider === 'bnovo' ? 'Bnovo' : 'RealtyCalendar'}. ИИ-агент автоматически отправляет эти фото гостям в переписке!
          </p>
        </div>
      )}

      {err && <div className="form-error mb-4">{err}</div>}
      {!items && !err && (
        <div className="loading-page" style={{ minHeight: '200px' }}>
          <div className="spinner" />
        </div>
      )}

      {items?.length === 0 && (
        <div className="empty-state">
          <div className="emoji">🏠</div>
          <h3>Пока нет квартир</h3>
          <p>
            {user?.pms_connected
              ? 'Подключите PMS или добавьте первую квартиру вручную'
              : 'Добавьте первую квартиру — бот будет показывать её гостям'}
          </p>
          <Link href="/apartments/new" className="btn btn-primary">
            + Добавить квартиру
          </Link>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {items?.map((a) => {
          const preview = a.preview_photo || (a.photos && a.photos[0]) || null;

          return (
            <div key={a.id} className="status-card interactive" style={{ cursor: 'default', padding: '16px 20px' }}>
              <Link
                href={`/apartments/${a.id}`}
                style={{ flex: 1, textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: '16px' }}
              >
                {preview ? (
                  <img
                    src={preview}
                    alt={a.title}
                    style={{
                      width: '64px',
                      height: '64px',
                      borderRadius: 'var(--radius-md)',
                      objectFit: 'cover',
                      flexShrink: 0,
                      border: '1px solid var(--border-primary)',
                    }}
                  />
                ) : (
                  <div className="icon blue" style={{ width: '64px', height: '64px', borderRadius: 'var(--radius-md)' }}>
                    🏠
                  </div>
                )}

                <div className="info" style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{a.title}</h3>
                    {(a as { from_pms?: boolean }).from_pms && (
                      <span className="badge badge-info" style={{ fontSize: '0.7rem' }}>Bnovo</span>
                    )}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {a.price ? `${a.price.toLocaleString()} ₽/ночь` : 'цена из PMS'}
                    {a.rc_apartment_id ? ` · ID ${a.rc_apartment_id}` : ''}
                    {a.photo_count ? ` · 📷 ${a.photo_count} фото` : a.photos?.length ? ` · 📷 ${a.photos.length} фото` : ''}
                  </p>
                  {a.address && a.address !== a.title && (
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      📍 {a.address}
                    </p>
                  )}
                </div>
              </Link>
              {!(a as { from_pms?: boolean }).from_pms && (
                <button
                  onClick={() => remove(a.id, a.title)}
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--danger)' }}
                >
                  Удалить
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
