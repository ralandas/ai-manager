// API client for the Progon Pro cabinet.

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v2';
const API_ORIGIN = BASE.replace(/\/api\/v2\/?$/, '');

// --- Types ---

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  created_at: string;
  pms_provider: string;
  pms_connected: boolean;
  pms_has_credentials: boolean;
  tg_connected: boolean;
  tg_has_config: boolean;
  tg_username: string | null;
  agent_running: boolean;
  agent_config: Record<string, unknown>;
}

export interface Apartment {
  id: string;
  title: string;
  address?: string | null;
  price?: number | null;
  rules?: string | null;
  checkin_instructions?: string | null;
  wifi_name?: string | null;
  wifi_password?: string | null;
  extra?: string | null;
  rc_apartment_id?: string | null;
  photo_count?: number;
  preview_photo?: string | null;
  photos?: string[];
  from_pms?: boolean;
}

export interface ApartmentInput {
  title: string;
  address?: string;
  price?: number;
  rules?: string;
  checkinInstructions?: string;
  wifiName?: string;
  wifiPassword?: string;
  extra?: string;
  rcApartmentId?: string;
}

export interface CalendarBookingItem {
  id: string;
  propertyId: string;
  roomTypeId?: number;
  guestName: string;
  guestPhone?: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  amount?: number;
  status: string;
  isPaid?: boolean;
}

export interface CalendarClosureItem {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  reason?: string;
}

export interface CalendarData {
  from: string;
  to: string;
  properties: Array<{
    id: string;
    title: string;
    address?: string;
    photos: string[];
    price?: number;
  }>;
  bookings: CalendarBookingItem[];
  closures: CalendarClosureItem[];
}

export interface PmsTestResult {
  ok: boolean;
  properties_count: number;
  properties: { id: string; title: string }[];
}

export interface TgStatus {
  connected: boolean;
  username: string | null;
  has_session: boolean;
  has_proxy: boolean;
  polling: boolean;
}

export interface AgentStatus {
  running: boolean;
  config: Record<string, unknown>;
  ready: boolean;
  pms_connected: boolean;
  tg_connected: boolean;
}

// --- Helpers ---

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data;
}

// --- Auth ---

export async function apiRegister(input: {
  email?: string;
  phone?: string;
  password: string;
  name?: string;
}): Promise<{ token: string; user: User }> {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function apiLogin(input: {
  login: string;
  password: string;
}): Promise<{ token: string; user: User }> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

// --- Profile ---

export async function getProfile(token: string): Promise<User> {
  const res = await fetch(`${BASE}/me`, { headers: auth(token) });
  return (await jsonOrThrow(res)).user;
}

export async function updateProfile(
  token: string,
  input: { name?: string; email?: string; phone?: string },
): Promise<User> {
  const res = await fetch(`${BASE}/me`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).user;
}

// --- Apartments ---

export async function listApartments(token: string): Promise<Apartment[]> {
  const res = await fetch(`${BASE}/apartments`, { headers: auth(token) });
  return (await jsonOrThrow(res)).apartments;
}

export async function getApartment(
  token: string,
  id: string,
): Promise<{ apartment: Apartment; photos: string[] }> {
  const res = await fetch(`${BASE}/apartments/${id}`, { headers: auth(token) });
  return jsonOrThrow(res);
}

export async function createApartment(token: string, input: ApartmentInput): Promise<Apartment> {
  const res = await fetch(`${BASE}/apartments`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).apartment;
}

export async function updateApartment(
  token: string,
  id: string,
  input: ApartmentInput,
): Promise<Apartment> {
  const res = await fetch(`${BASE}/apartments/${id}`, {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).apartment;
}

export async function deleteApartment(token: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/apartments/${id}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  await jsonOrThrow(res);
}

// --- Calendar ---

export async function getCalendar(
  token: string,
  from?: string,
  to?: string,
): Promise<CalendarData> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${BASE}/calendar${query}`, { headers: auth(token) });
  return (await jsonOrThrow(res)).calendar;
}

// --- Photos ---

export function photoUrl(id: string, file: string): string {
  if (file.startsWith('http')) return file;
  return `${API_ORIGIN}/photos/${id}/${file}`;
}

export async function uploadPhoto(token: string, id: string, file: File): Promise<string[]> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/apartments/${id}/photos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return (await jsonOrThrow(res)).photos;
}

export async function deletePhoto(token: string, id: string, file: string): Promise<string[]> {
  const res = await fetch(`${BASE}/apartments/${id}/photos/${file}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  return (await jsonOrThrow(res)).photos;
}

// --- PMS ---

export async function connectPms(
  token: string,
  provider: string,
  credentials: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/pms/connect`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ provider, credentials }),
  });
  return jsonOrThrow(res);
}

export async function testPms(
  token: string,
  provider: string,
  credentials: Record<string, unknown>,
): Promise<PmsTestResult> {
  const res = await fetch(`${BASE}/pms/test`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ provider, credentials }),
  });
  return jsonOrThrow(res);
}

export async function disconnectPms(token: string): Promise<void> {
  const res = await fetch(`${BASE}/pms/disconnect`, {
    method: 'DELETE',
    headers: auth(token),
  });
  await jsonOrThrow(res);
}

// --- Telegram ---

export async function connectTelegram(
  token: string,
  config: {
    apiId: number;
    apiHash: string;
    session: string;
    proxy?: string;
    username?: string;
    privateOnly?: boolean;
    polling?: boolean;
  },
): Promise<{ ok: boolean; username: string | null }> {
  const res = await fetch(`${BASE}/telegram/connect`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(config),
  });
  return jsonOrThrow(res);
}

export async function testTelegram(
  token: string,
  config?: {
    apiId: number;
    apiHash: string;
    session: string;
    proxy?: string;
  },
): Promise<{ ok: boolean; authorized: boolean }> {
  const res = await fetch(`${BASE}/telegram/test`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(config ?? {}),
  });
  return jsonOrThrow(res);
}

export async function getTelegramStatus(token: string): Promise<TgStatus> {
  const res = await fetch(`${BASE}/telegram/status`, { headers: auth(token) });
  return jsonOrThrow(res);
}

export async function disconnectTelegram(token: string): Promise<void> {
  const res = await fetch(`${BASE}/telegram/disconnect`, {
    method: 'DELETE',
    headers: auth(token),
  });
  await jsonOrThrow(res);
}

// --- Agent ---

export async function getAgentStatus(token: string): Promise<AgentStatus> {
  const res = await fetch(`${BASE}/agent/status`, { headers: auth(token) });
  return jsonOrThrow(res);
}

export async function startAgent(
  token: string,
  config?: Record<string, unknown>,
): Promise<{ ok: boolean; running: boolean }> {
  const res = await fetch(`${BASE}/agent/start`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ config }),
  });
  return jsonOrThrow(res);
}

export async function stopAgent(token: string): Promise<{ ok: boolean; running: boolean }> {
  const res = await fetch(`${BASE}/agent/stop`, {
    method: 'POST',
    headers: auth(token),
  });
  return jsonOrThrow(res);
}
