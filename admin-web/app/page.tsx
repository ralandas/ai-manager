'use client';

import { useEffect, useState } from 'react';
import {
  login,
  listApartments,
  getApartment,
  saveApartment,
  listPhotos,
  uploadPhoto,
  deletePhoto,
  photoUrl,
  type ApartmentInfo,
  type ApartmentListItem,
} from '../lib/api';

const TOKEN_KEY = 'ai_manager_admin_token';

export default function Page() {
  const [token, setToken] = useState<string | null>(null);
  const [screen, setScreen] = useState<'login' | 'list' | 'edit'>('login');
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) {
      setToken(saved);
      setScreen('list');
    }
  }, []);

  if (screen === 'login')
    return (
      <Login
        onOk={(t) => {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
          setScreen('list');
        }}
      />
    );

  if (screen === 'list' && token)
    return (
      <List
        token={token}
        onPick={(id) => {
          setEditId(id);
          setScreen('edit');
        }}
        onLogout={() => {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setScreen('login');
        }}
      />
    );

  if (screen === 'edit' && token && editId)
    return <Edit token={token} id={editId} onBack={() => setScreen('list')} />;

  return null;
}

function Login({ onOk }: { onOk: (t: string) => void }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const ok = await login(value.trim());
      if (ok) onOk(value.trim());
      else setErr('Неверный пароль');
    } catch {
      setErr('Не удалось связаться с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <h1>Кабинет квартир</h1>
      <p className="sub">Введите пароль доступа</p>
      <div className="card">
        <label>Пароль</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="•••••••"
        />
        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 16 }}>
          <button onClick={submit} disabled={busy || !value}>
            {busy ? 'Проверяю…' : 'Войти'}
          </button>
        </div>
      </div>
    </div>
  );
}

function List({
  token,
  onPick,
  onLogout,
}: {
  token: string;
  onPick: (id: string) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<ApartmentListItem[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    listApartments(token)
      .then(setItems)
      .catch(() => setErr('Не удалось загрузить квартиры'));
  }, [token]);

  return (
    <div className="wrap">
      <div className="row">
        <h1>Мои квартиры</h1>
        <button className="ghost" onClick={onLogout}>
          Выйти
        </button>
      </div>
      <p className="sub">Выберите квартиру, чтобы заполнить правила и заселение</p>
      {err && <div className="err">{err}</div>}
      {!items && !err && <p className="sub">Загрузка…</p>}
      {items?.map((a) => (
        <div
          key={a.id}
          className="item"
          onClick={() => onPick(a.id)}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{a.title}</div>
            <div className="sub" style={{ margin: 0 }}>
              ID: {a.id}
            </div>
          </div>
          <span className={`badge ${a.filled ? 'ok' : 'warn'}`}>
            {a.filled ? 'Заполнено' : 'Не заполнено'}
          </span>
        </div>
      ))}
    </div>
  );
}

function Edit({ token, id, onBack }: { token: string; id: string; onBack: () => void }) {
  const [info, setInfo] = useState<ApartmentInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    getApartment(token, id)
      .then(setInfo)
      .catch(() => setErr('Не удалось загрузить квартиру'));
    listPhotos(token, id)
      .then(setPhotos)
      .catch(() => {});
  }, [token, id]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setErr('');
    try {
      let latest = photos;
      for (const f of Array.from(files)) latest = await uploadPhoto(token, id, f);
      setPhotos(latest);
    } catch {
      setErr('Не удалось загрузить фото');
    } finally {
      setUploading(false);
    }
  };

  const onDeletePhoto = async (file: string) => {
    try {
      setPhotos(await deletePhoto(token, id, file));
    } catch {
      setErr('Не удалось удалить фото');
    }
  };

  const set = (patch: Partial<ApartmentInfo>) => setInfo((v) => (v ? { ...v, ...patch } : v));

  const save = async () => {
    if (!info) return;
    setBusy(true);
    setErr('');
    try {
      await saveApartment(token, id, info);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setErr('Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="wrap">{err ? <div className="err">{err}</div> : <p className="sub">Загрузка…</p>}</div>;

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>
        ← К списку
      </button>
      <h1>{info.title}</h1>
      <p className="sub">Эти данные бот отправит гостю на странице квартиры</p>

      <div className="card">
        <label>Адрес</label>
        <div className="hint">Полный адрес, как гостю его искать</div>
        <input
          value={info.address ?? ''}
          onChange={(e) => set({ address: e.target.value })}
          placeholder="г. Чита, ул. Шилова, 12, кв. 5"
        />

        <label>Фото квартиры</label>
        <div className="hint">
          Их бот отправит клиенту по запросу, с подписью (название + цена)
        </div>
        <div className="photos">
          {photos.map((f) => (
            <div className="photo" key={f}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl(id, f)} alt={f} />
              <button type="button" className="del" onClick={() => onDeletePhoto(f)}>
                ✕
              </button>
            </div>
          ))}
          <label className="uploader">
            {uploading ? 'Загрузка…' : '+ Добавить'}
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => onUpload(e.target.files)}
            />
          </label>
        </div>

        <label>Как заселиться</label>
        <div className="hint">
          Пошагово: код подъезда, где ключница/сейф-бокс, код от неё, что делать с ключами
        </div>
        <textarea
          value={info.checkinInstructions ?? ''}
          onChange={(e) => set({ checkinInstructions: e.target.value })}
          placeholder={
            'Заселение дистанционное. За день до заезда пришлём код от подъезда и сейф-бокса. ' +
            'Сейф-бокс справа от входной двери. После заезда верните ключи в сейф-бокс.'
          }
        />

        <label>Правила проживания</label>
        <div className="hint">Курение, тишина, гости, животные, депозит</div>
        <textarea
          value={info.rules ?? ''}
          onChange={(e) => set({ rules: e.target.value })}
          placeholder={
            'Не курить (штраф). Тишина с 22:00 до 08:00. Без вечеринок. ' +
            'Животные по согласованию. Депозит 3000 ₽ возвращается после выезда.'
          }
        />

        <div className="grid2">
          <div>
            <label>Wi‑Fi: сеть</label>
            <div className="hint">Название сети</div>
            <input
              value={info.wifi?.name ?? ''}
              onChange={(e) => set({ wifi: { ...info.wifi, name: e.target.value } })}
              placeholder="Shilova12"
            />
          </div>
          <div>
            <label>Wi‑Fi: пароль</label>
            <div className="hint">Пароль от сети</div>
            <input
              value={info.wifi?.password ?? ''}
              onChange={(e) => set({ wifi: { ...info.wifi, password: e.target.value } })}
              placeholder="12345678"
            />
          </div>
        </div>

        <label>Дополнительно</label>
        <div className="hint">Что ещё важно знать гостю (парковка, лифт, мусор и т.п.)</div>
        <textarea
          value={info.extra ?? ''}
          onChange={(e) => set({ extra: e.target.value })}
          placeholder="Парковка во дворе бесплатная. Мусоропровод на этаже."
        />

        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 18 }}>
          <button onClick={save} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
      {saved && <div className="toast">Сохранено ✓</div>}
    </div>
  );
}
