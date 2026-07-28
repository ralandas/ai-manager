import { sql } from '../db/index.js';

/**
 * Read access to owner apartments for the agent. Cards live in our DB; RC
 * operations (availability/booking/payment) use rc_apartment_id when present.
 *
 * Pilot: a single owner runs the whole flow. AGENT_OWNER_ID (env) picks which
 * owner's catalog the agent serves. Later, per-conversation routing can select
 * the owner by the connected messenger account.
 */
export interface AptCard {
  id: string;
  title: string;
  address: string | null;
  price: number | null;
  rules: string | null;
  checkinInstructions: string | null;
  wifiName: string | null;
  wifiPassword: string | null;
  extra: string | null;
  rcApartmentId: string | null;
}

function map(r: Record<string, unknown>): AptCard {
  return {
    id: String(r.id),
    title: r.title as string,
    address: (r.address as string) ?? null,
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    rules: (r.rules as string) ?? null,
    checkinInstructions: (r.checkin_instructions as string) ?? null,
    wifiName: (r.wifi_name as string) ?? null,
    wifiPassword: (r.wifi_password as string) ?? null,
    extra: (r.extra as string) ?? null,
    rcApartmentId: (r.rc_apartment_id as string) ?? null,
  };
}

export async function listOwnerApartments(ownerId: string): Promise<AptCard[]> {
  const rows = await sql`SELECT * FROM apartments WHERE owner_id = ${ownerId} ORDER BY created_at`;
  return rows.map((r) => map(r as Record<string, unknown>));
}

export async function getApartmentCard(ownerId: string, id: string): Promise<AptCard | null> {
  const rows = await sql`
    SELECT * FROM apartments WHERE owner_id = ${ownerId} AND id = ${id} LIMIT 1`;
  return rows.length ? map(rows[0] as Record<string, unknown>) : null;
}

/** Resolve our card id -> RC apartment id (for booking/availability). */
export async function rcIdForCard(ownerId: string, id: string): Promise<string | null> {
  const card = await getApartmentCard(ownerId, id);
  return card?.rcApartmentId ?? null;
}
