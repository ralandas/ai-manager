// Client for the AI-manager admin API on the VPS.
// Set NEXT_PUBLIC_API_BASE in Vercel to the public API URL (e.g. https://your-domain/api/admin).

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

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
