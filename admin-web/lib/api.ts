// Client for the AI-manager admin API.
// Default is same-origin "/api/admin" — on Netlify this is proxied to the VPS
// (see netlify.toml), so the browser only talks https and there's no mixed-content.
// Override with NEXT_PUBLIC_API_BASE if you host the API elsewhere.

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/admin';

export interface ApartmentListItem {
  id: string;
  title: string;
  filled: boolean;
}

export interface ApartmentInfo {
  id: string;
  title: string;
  address?: string;
  rules?: string;
  checkinInstructions?: string;
  wifi?: { name?: string; password?: string };
  extra?: string;
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export async function login(token: string): Promise<boolean> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return res.ok;
}

export async function listApartments(token: string): Promise<ApartmentListItem[]> {
  const res = await fetch(`${BASE}/apartments`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return (await res.json()).apartments;
}

export async function getApartment(token: string, id: string): Promise<ApartmentInfo> {
  const res = await fetch(`${BASE}/apartments/${id}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`get failed: ${res.status}`);
  return (await res.json()).info;
}

export async function saveApartment(
  token: string,
  id: string,
  info: Partial<ApartmentInfo>,
): Promise<ApartmentInfo> {
  const res = await fetch(`${BASE}/apartments/${id}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(info),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  return (await res.json()).info;
}

const API_ORIGIN = BASE.replace(/\/api\/admin\/?$/, '');

/** Public URL of a stored photo (for previews and the guest-facing send). */
export function photoUrl(id: string, file: string): string {
  return `${API_ORIGIN}/photos/${id}/${file}`;
}

export async function listPhotos(token: string, id: string): Promise<string[]> {
  const res = await fetch(`${BASE}/apartments/${id}/photos`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`photos failed: ${res.status}`);
  return (await res.json()).photos;
}

export async function uploadPhoto(token: string, id: string, file: File): Promise<string[]> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/apartments/${id}/photos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }, // no content-type: browser sets multipart boundary
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()).photos;
}

export async function deletePhoto(token: string, id: string, file: string): Promise<string[]> {
  const res = await fetch(`${BASE}/apartments/${id}/photos/${file}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  return (await res.json()).photos;
}
