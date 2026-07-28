'use client';

import { useEffect, useState } from 'react';
import {
  register,
  login,
  listApartments,
  getApartment,
  createApartment,
  updateApartment,
  deleteApartment,
  uploadPhoto,
  deletePhoto,
  photoUrl,
  type Apartment,
  type ApartmentInput,
} from '../lib/api';

const TOKEN_KEY = 'ai_manager_token';

export default function Page() {
  const [token, setToken] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null); // null=list, 'new'=create, id=edit
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) setToken(t);
    setReady(true);
  }, []);

  if (!ready) return null;

  if (!token)
    return (
      <Auth
        onAuthed={(t) => {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setEditId(null);
  };

  if (editId)
    return (
      <Edit
        token={token}
        id={editId}
        onBack={() => setEditId(null)}
      />
    );

  return <List token={token} onOpen={setEditId} onLogout={logout} />;
}

// ---------- Auth ----------
function Auth({ onAuthed }: { onAuthed: (t: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (mode === 'register') {
        const isEmail = loginId.includes('@');
        const { token } = await register({
          email: isEmail ? loginId.trim() : undefined,
          phone: isEmail ? undefined : loginId.trim(),
          password,
          name: name.trim() || undefined,
        });
        onAuthed(token);
      } else {
        const { token } = await login({ login: loginId.trim(), password });
        onAuthed(token);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap narrow">
      <h1>Кабинет квартир</h1>
      <p className="sub">{mode === 'login' ? 'Вход' : 'Регистрация'}</p>
      <div className="card">
        {mode === 'register' && (
          <>
            <label>Имя</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Как к вам обращаться" />
          </>
        )}
        <label>Email или телефон</label>
        <input
          value={loginId}
          onChange={(e) => setLoginId(e.target.value)}
          placeholder="you@mail.ru или +7..."
        />
        <label>Пароль</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="минимум 6 символов"
        />
        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 16 }}>
          <button onClick={submit} disabled={busy || !loginId || !password}>
            {busy ? '…' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </button>
        </div>
        <button
          className="ghost"
          style={{ marginTop: 10 }}
          onClick={() => {
            setErr('');
            setMode(mode === 'login' ? 'register' : 'login');
          }}
        >
          {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>
      </div>
    </div>
  );
}

// ---------- List ----------
function List({
  token,
  onOpen,
  onLogout,
}: {
  token: string;
  onOpen: (id: string) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<Apartment[] | null>(null);
  const [err, setErr] = useState('');

  const load = () =>
    listApartments(token)
      .then(setItems)
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const remove = async (id: string, title: string) => {
    if (!confirm(`Удалить «${title}»? Это действие необратимо.`)) return;
    await deleteApartment(token, id);
    load();
  };

  return (
    <div className="wrap">
      <div className="row">
        <h1>Мои квартиры</h1>
        <button className="ghost" onClick={onLogout}>
          Выйти
        </button>
      </div>
      <p className="sub">Добавляйте квартиры, заполняйте правила, заселение и фото</p>

      <button onClick={() => onOpen('new')} style={{ marginBottom: 8 }}>
        + Добавить квартиру
      </button>

      {err && <div className="err">{err}</div>}
      {!items && !err && <p className="sub">Загрузка…</p>}
      {items?.length === 0 && <p className="sub">Пока нет квартир. Добавьте первую.</p>}

      {items?.map((a) => (
        <div key={a.id} className="item">
          <div onClick={() => onOpen(a.id)} style={{ cursor: 'pointer', flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{a.title}</div>
            <div className="sub" style={{ margin: 0 }}>
              {a.price ? `${a.price} ₽/ночь` : 'цена не указана'}
              {a.rc_apartment_id ? ` · RC ${a.rc_apartment_id}` : ''}
              {a.photo_count ? ` · ${a.photo_count} фото` : ''}
            </div>
          </div>
          <button className="ghost danger" onClick={() => remove(a.id, a.title)}>
            Удалить
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Edit / Create ----------
function Edit({ token, id, onBack }: { token: string; id: string; onBack: () => void }) {
  const isNew = id === 'new';
  const [form, setForm] = useState<ApartmentInput>({ title: '' });
  const [realId, setRealId] = useState<string | null>(isNew ? null : id);
  const [photos, setPhotos] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (isNew) return;
    getApartment(token, id)
      .then(({ apartment: a, photos }) => {
        setForm({
          title: a.title,
          address: a.address ?? undefined,
          price: a.price ?? undefined,
          rules: a.rules ?? undefined,
          checkinInstructions: a.checkin_instructions ?? undefined,
          wifiName: a.wifi_name ?? undefined,
          wifiPassword: a.wifi_password ?? undefined,
          extra: a.extra ?? undefined,
          rcApartmentId: a.rc_apartment_id ?? undefined,
        });
        setPhotos(photos);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, id]);

  const set = (patch: Partial<ApartmentInput>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.title?.trim()) {
      setErr('Укажите название');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      if (isNew && !realId) {
        const a = await createApartment(token, form);
        setRealId(a.id); // now photos can be uploaded
      } else if (realId) {
        await updateApartment(token, realId, form);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || !realId) return;
    setUploading(true);
    setErr('');
    try {
      let latest = photos;
      for (const f of Array.from(files)) latest = await uploadPhoto(token, realId, f);
      setPhotos(latest);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось загрузить фото');
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <div className="wrap"><p className="sub">Загрузка…</p></div>;

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>
        ← К списку
      </button>
      <h1>{isNew ? 'Новая квартира' : form.title || 'Квартира'}</h1>
      <p className="sub">Эти данные бот использует в переписке с гостями</p>

      <div className="card">
        <label>Название *</label>
        <div className="hint">Как квартира отображается гостю</div>
        <input value={form.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="Шилова 12, студия" />

        <div className="grid2">
          <div>
            <label>Цена за ночь, ₽</label>
            <div className="hint">Базовая цена</div>
            <input
              type="number"
              value={form.price ?? ''}
              onChange={(e) => set({ price: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="3100"
            />
          </div>
          <div>
            <label>ID в Realty Calendar</label>
            <div className="hint">Если брони идут через RC (необязательно)</div>
            <input
              value={form.rcApartmentId ?? ''}
              onChange={(e) => set({ rcApartmentId: e.target.value })}
              placeholder="281403"
            />
          </div>
        </div>

        <label>Адрес</label>
        <input value={form.address ?? ''} onChange={(e) => set({ address: e.target.value })} placeholder="г. Чита, ул. Шилова, 12" />

        {/* Photos — only after the apartment exists (need its id) */}
        <label>Фото</label>
        <div className="hint">
          {realId ? 'Бот отправит их гостю по запросу (с подписью)' : 'Сначала сохраните квартиру, потом добавьте фото'}
        </div>
        {realId && (
          <div className="photos">
            {photos.map((f) => (
              <div className="photo" key={f}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(realId, f)} alt={f} />
                <button
                  type="button"
                  className="del"
                  onClick={async () => setPhotos(await deletePhoto(token, realId, f))}
                >
                  ✕
                </button>
              </div>
            ))}
            <label className="uploader">
              {uploading ? '…' : '+ Фото'}
              <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onUpload(e.target.files)} />
            </label>
          </div>
        )}

        <label>Как заселиться</label>
        <div className="hint">Код подъезда, где ключница/сейф-бокс, код от неё, что с ключами</div>
        <textarea
          value={form.checkinInstructions ?? ''}
          onChange={(e) => set({ checkinInstructions: e.target.value })}
          placeholder="Заселение дистанционное. За день до заезда пришлём код от подъезда и сейф-бокса…"
        />

        <label>Правила проживания</label>
        <div className="hint">Курение, тишина, гости, животные, депозит</div>
        <textarea
          value={form.rules ?? ''}
          onChange={(e) => set({ rules: e.target.value })}
          placeholder="Не курить. Тишина с 22:00 до 08:00. Без вечеринок. Депозит 3000 ₽…"
        />

        <div className="grid2">
          <div>
            <label>Wi‑Fi: сеть</label>
            <input value={form.wifiName ?? ''} onChange={(e) => set({ wifiName: e.target.value })} placeholder="Shilova12" />
          </div>
          <div>
            <label>Wi‑Fi: пароль</label>
            <input value={form.wifiPassword ?? ''} onChange={(e) => set({ wifiPassword: e.target.value })} placeholder="12345678" />
          </div>
        </div>

        <label>Дополнительно</label>
        <div className="hint">Парковка, лифт, мусор и т.п.</div>
        <textarea value={form.extra ?? ''} onChange={(e) => set({ extra: e.target.value })} placeholder="Парковка во дворе бесплатная." />

        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 18 }}>
          <button onClick={save} disabled={busy}>
            {busy ? 'Сохраняю…' : isNew && !realId ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </div>
      {saved && <div className="toast">Сохранено ✓</div>}
    </div>
  );
}
