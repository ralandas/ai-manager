// Client for the AI-manager owner API (v2, multi-tenant).
// Same-origin "/api/v2" by default — on Netlify this is proxied to the VPS
// (see netlify.toml), so the browser only talks https (no mixed-content).

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v2';
const API_ORIGIN = BASE.replace(/\/api\/v2\/?$/, '');

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
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
}

/** Body sent on create/update (camelCase; server maps to columns). */
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

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data;
}

// --- auth ---
export async function register(input: {
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
  return jsonOrThrow(res) as Promise<{ token: string; user: User }>;
}

export async function login(input: {
  login: string;
  password: string;
}): Promise<{ token: string; user: User }> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res) as Promise<{ token: string; user: User }>;
}

// --- apartments ---
export async function listApartments(token: string): Promise<Apartment[]> {
  const res = await fetch(`${BASE}/apartments`, { headers: auth(token) });
  return (await jsonOrThrow(res)).apartments;
}

export async function getApartment(
  token: string,
  id: string,
): Promise<{ apartment: Apartment; photos: string[] }> {
  const res = await fetch(`${BASE}/apartments/${id}`, { headers: auth(token) });
  return jsonOrThrow(res) as Promise<{ apartment: Apartment; photos: string[] }>;
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
  const res = await fetch(`${BASE}/apartments/${id}`, { method: 'DELETE', headers: auth(token) });
  await jsonOrThrow(res);
}

// --- photos ---
export function photoUrl(id: string, file: string): string {
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
