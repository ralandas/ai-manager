import { logger } from '../logger.js';
import type {
  AvailabilityQuery,
  AvailabilityResult,
  Booking,
  Checkout,
  CreateBookingInput,
  PaymentLink,
  PmsConnector,
  Property,
} from './types.js';

/**
 * Bnovo PMS connector.
 *
 * Bnovo has no usable official API for creating bookings, so this is built by
 * reverse-engineering the web cabinet at online.bnovo.ru (same approach as
 * RealtyCalendar). Auth is the `SID` session cookie. See knowledge/_bnovo_reverse.md
 * for the captured request/response contracts.
 *
 * Endpoints used:
 *   POST /planning/bookings   (multipart dfrom/dto/daily=0) -> { result:[booking], closures:[] }
 *   GET  /tariff/getAvailable?dateFrom&dateTo&arrivalTime&departureTime      -> price/availability
 *   POST /booking/add         (json)  -> { result:"success", first_booking_id }
 */
export interface BnovoCreds {
  /** Login credentials — the client logs in and refreshes the SID itself. */
  username?: string;
  password?: string;
  /** Optional seed session cookie; if login creds are set it's auto-refreshed. */
  sid?: string;
  baseUrl?: string;
  userAgent?: string;
  /** Default arrival/departure clock times used when creating bookings. */
  arrivalTime?: string; // "14:00"
  departureTime?: string; // "12:00"
  /** Account-specific tariff/plan and marketing source ids (from captured add call). */
  planId?: string; // "53582"
  marketingSourceId?: string; // "36452"
}

/** One booking row from POST /planning/bookings (fields we use). */
interface BnovoBooking {
  booking_id: string;
  status_id: number;
  status_name: string;
  real_arrival: string; // "2026-07-20 15:00:00"
  real_departure: string;
  room_id: number;
  room_type_id?: number;
  dual_roomtype_id?: number;
  number: string; // internal code, not a human name
  surname: string;
  name: string;
  phone: string;
  adults: number;
  children: number;
  amount: string; // "56700.00"
}

interface BnovoClosure {
  room_id: string;
  date_from: string; // "10-01-2026"
  date_to: string; // "01-12-2027"
  reason: string;
}

/**
 * POST /roomTypes/getRoomTypeVariation — per-room-type price for a date range,
 * plus the two things the booking flow needs but wasn't reading before:
 *   - `adults` / `places` — how many guests the room sleeps (capacity)
 *   - `date_restrictions[date]` — per-day minstay/maxstay + arrival/departure
 *     closures (minstay_a is the arrival-specific minimum; falls back to minstay)
 */
interface BnovoDateRestriction {
  date?: string;
  minstay?: number;
  minstay_a?: number;
  maxstay?: number;
  closed?: boolean;
  closed_arrival?: boolean;
  closed_departure?: boolean;
}
/** Stay restrictions for one room over a requested window, distilled from Bnovo. */
interface RoomRestriction {
  minStay: number;
  maxStay: number;
  closedArrival: boolean;
}

/**
 * GET /tariff/getPricesAndRestrictionsData?...&parts=restrictions — the cabinet's
 * real per-room-type, per-date restriction grid (values are strings like "3").
 * restrictions[roomTypeId][YYYY-MM-DD] = { minstay, minstay_a, maxstay, ... }.
 */
interface BnovoRestrictionCell {
  minstay?: string | number;
  minstay_a?: string | number;
  maxstay?: string | number;
  closed?: string | boolean;
  closed_arrival?: string | boolean;
  closed_departure?: string | boolean;
}
interface BnovoRestrictionsResponse {
  data?: { restrictions?: Record<string, Record<string, BnovoRestrictionCell>> };
}
interface BnovoVariationResponse {
  result: string;
  data?: {
    variation?: Array<{
      roomtype_id?: number;
      roomtype_name?: string;
      placings?: Array<{
        price?: number;
        rooms_count?: number;
        adults?: number;
        places?: { main?: number; extra?: number; no_place?: number };
        date_restrictions?: Record<string, BnovoDateRestriction>;
      }>;
    }>;
  };
}

/** POST /roomTypes/get_room_presentation_data — address (in description) + photos. */
interface BnovoPresentationResponse {
  result: string; // "success"
  data?: {
    pms_room_type?: { name?: string; description?: string; adults?: string };
    photos?: Array<{ url?: string }>;
  };
}

interface BnovoBookingsResponse {
  result: BnovoBooking[];
  closures: BnovoClosure[];
  errors?: unknown[];
}

/** A metro stop near a flat, parsed from the owner's description. */
export interface MetroStop {
  station: string;
  walkMin?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class BnovoClient implements PmsConnector {
  private readonly base: string;
  private readonly ua: string;
  private readonly arrivalTime: string;
  private readonly departureTime: string;
  private readonly planId: string;
  private readonly marketingSourceId: string;

  private sid: string | null = null;

  constructor(private readonly creds: BnovoCreds) {
    if (!creds.sid && !(creds.username && creds.password)) {
      throw new Error('Bnovo requires either a SID cookie or username+password');
    }
    this.sid = creds.sid ?? null;
    this.base = creds.baseUrl ?? 'https://online.bnovo.ru';
    this.ua =
      creds.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    this.arrivalTime = creds.arrivalTime ?? '14:00';
    this.departureTime = creds.departureTime ?? '12:00';
    this.planId = creds.planId ?? '53582';
    this.marketingSourceId = creds.marketingSourceId ?? '36452';
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: `SID=${this.sid ?? ''}`,
      'User-Agent': this.ua,
      Accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      Origin: this.base,
      ...extra,
    };
  }

  /**
   * Log in with username/password and capture the fresh SID from Set-Cookie.
   * POST / (x-www-form-urlencoded) { mat, username, password } -> 302 + Set-Cookie SID.
   */
  private async login(): Promise<boolean> {
    if (!this.creds.username || !this.creds.password) return false;
    try {
      const body = new URLSearchParams({
        mat: '',
        username: this.creds.username,
        password: this.creds.password,
      }).toString();
      const res = await fetch(`${this.base}/`, {
        method: 'post',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'User-Agent': this.ua,
          Origin: this.base,
          Referer: `${this.base}/`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
      for (const line of cookies) {
        const m = /SID=([^;]+)/.exec(line ?? '');
        if (m) {
          this.sid = m[1]!;
          logger.info({ status: res.status }, 'Bnovo login ok, SID refreshed');
          return true;
        }
      }
      logger.error({ status: res.status }, 'Bnovo login: no SID in Set-Cookie');
      return false;
    } catch (err) {
      logger.error({ err }, 'Bnovo login threw');
      return false;
    }
  }

  private async request<T>(
    method: string,
    endpoint: string,
    opts: { body?: string; headers?: Record<string, string> } = {},
    retrying = false,
  ): Promise<T | null> {
    const url = `${this.base}${endpoint}`;
    // Ensure we have a session before the first call.
    if (!this.sid && !(await this.login())) return null;
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(opts.headers),
        body: opts.body,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      logger.info({ url, method, status: res.status }, 'Bnovo request');

      // Session died (expired cookie): Bnovo answers "session_expired" or 401/403.
      const expired = res.status === 401 || res.status === 403 || text.trim() === 'session_expired';
      if (expired && !retrying && (await this.login())) {
        return this.request<T>(method, endpoint, opts, true);
      }
      if (!res.ok || expired) {
        logger.error({ url, status: res.status, body: text.slice(0, 300) }, 'Bnovo request failed');
        return null;
      }
      return text.trim() ? (JSON.parse(text) as T) : null;
    } catch (err) {
      logger.error({ url, err }, 'Bnovo request threw');
      return null;
    }
  }

  /** Raw text GET (for HTML pages like /roomTypes). Re-auths on session_expired. */
  private async requestText(method: string, endpoint: string, retrying = false): Promise<string | null> {
    if (!this.sid && !(await this.login())) return null;
    try {
      const res = await fetch(`${this.base}${endpoint}`, {
        method,
        headers: { Cookie: `SID=${this.sid ?? ''}`, 'User-Agent': this.ua, 'x-requested-with': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if ((res.status === 401 || res.status === 403 || text.trim() === 'session_expired') && !retrying && (await this.login())) {
        return this.requestText(method, endpoint, true);
      }
      return res.ok ? text : null;
    } catch (err) {
      logger.error({ endpoint, err }, 'Bnovo requestText threw');
      return null;
    }
  }

  /** POST /planning/bookings — bookings + closures overlapping [dfrom, dto]. */
  private async fetchBookings(dfrom: string, dto: string): Promise<BnovoBookingsResponse> {
    const boundary = '----AIManagerBnovo' + dfrom.replace(/\D/g, '');
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = part('dfrom', dfrom) + part('dto', dto) + part('daily', '0') + `--${boundary}--\r\n`;
    const res = await this.request<BnovoBookingsResponse>('post', '/planning/bookings', {
      body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    return res ?? { result: [], closures: [] };
  }

  /**
   * Rooms dictionary room_id -> { roomTypeId, number }. Bnovo needs room_type_id
   * to create a booking; in /planning/bookings that value is `dual_roomtype_id`
   * (verified: room_id 1222930 -> dual_roomtype_id 666444, the pair a real
   * /booking/add used). Built from a wide bookings window and cached.
   */
  private roomsCache: Map<string, { roomTypeId: number; number: string; name?: string }> | null =
    null;
  private namesCache: Map<string, string> | null = null;
  /** room_type_id -> presentation (address + description + photos), cached per process. */
  private presCache = new Map<string, { address?: string; description?: string; photos: string[]; metro?: MetroStop[] }>();
  /** true once listProperties has enriched titles with real addresses. */
  private addressesEnriched = false;

  /**
   * Presentation data for a room type: the guest-facing address (parsed from the
   * owner's description) and the photo gallery. Source is the same endpoint the
   * cabinet's "presentation" popup uses:
   *   POST /roomTypes/get_room_presentation_data  { room_type_id }
   *     -> { data: { pms_room_type: { name, description, adults }, photos: [{ url }] } }
   * Cached per room type; best-effort (returns empty on failure).
   */
  private async presentation(
    roomTypeId: string,
  ): Promise<{ address?: string; description?: string; photos: string[]; metro?: MetroStop[] }> {
    const key = String(roomTypeId);
    const cached = this.presCache.get(key);
    if (cached) return cached;
    let out: { address?: string; description?: string; photos: string[]; metro?: MetroStop[] } = { photos: [] };
    try {
      const resp = await this.request<BnovoPresentationResponse>(
        'post',
        '/roomTypes/get_room_presentation_data?rp=vue',
        { body: JSON.stringify({ room_type_id: key }), headers: { 'content-type': 'application/json' } },
      );
      if (resp?.result === 'success' && resp.data) {
        const photos = (resp.data.photos ?? [])
          .map((p) => p.url)
          .filter((u): u is string => typeof u === 'string' && u.length > 0);
        const description = resp.data.pms_room_type?.description;
        out = { address: this.parseAddress(description), description, photos, metro: this.parseMetro(description) };
      }
    } catch (err) {
      logger.warn({ roomTypeId, err }, 'Bnovo presentation fetch failed');
    }
    this.presCache.set(key, out);
    return out;
  }

  /**
   * Full free-text description of a room (by room_id) — the owner's listing text
   * with amenities (kitchen/bathroom/tech/rules). The agent reads this to answer
   * "есть ли холодильник / кондиционер / ...". Returns null if unavailable.
   */
  async getDescription(propertyId: string): Promise<string | null> {
    const rooms = await this.rooms();
    const entry = rooms.get(String(propertyId));
    if (!entry) return null;
    return (await this.presentation(String(entry.roomTypeId))).description ?? null;
  }

  /**
   * Pull metro stops from the owner's description. They write a "Метро:" block:
   *   Метро:
   *   ◆Технологический институт (7 минут пешком)
   *   ◆ Фрунзенская (7 минут пешком)
   * Returns [{ station, walkMin }]. Best-effort; empty if no block/parse.
   */
  private parseMetro(description?: string): MetroStop[] {
    if (!description) return [];
    const stops: MetroStop[] = [];
    const seen = new Set<string>();
    const lines = description.split('\n');
    // Find the "Метро:" HEADER line (colon form), then read the ◆-bullet lines
    // right under it. Anchoring on the header (not the word "метро", which also
    // appears in the intro prose and in "К услугам гостей" bullet lists) keeps
    // us from grabbing amenities as stations.
    let inBlock = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^метро\s*:/i.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      const isBullet = /^[◆•▪●]/.test(line);
      if (!isBullet) {
        if (line === '') continue; // tolerate a blank line inside the block
        break; // next section header — stop
      }
      const t = line.replace(/^[◆•▪●\s]+/, '').trim();
      const walk = t.match(/(\d+)\s*мин/i);
      const station = t.replace(/\(.*$/, '').replace(/\s+\d+\s*мин.*$/i, '').trim();
      if (station.length < 3) continue;
      const key = station.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      stops.push({ station, walkMin: walk ? Number(walk[1]) : undefined });
      if (stops.length >= 4) break;
    }
    return stops;
  }

  /** Pull a clean street address from the owner's free-text description. */
  private parseAddress(description?: string): string | undefined {
    if (!description) return undefined;
    // Owners write "Адрес:\n<street>" in the description; take that line.
    const m = description.match(/Адрес:\s*\n?\s*([^\n]{4,80})/i);
    const line = m?.[1]?.trim();
    if (!line) return undefined;
    // Strip trailing metro/section markers that sometimes share the line.
    return line.replace(/\s*(Метро|Как добраться|Спальные).*/i, '').trim() || undefined;
  }

  /**
   * Human room labels room_id -> name (e.g. "5кр3", "Бр37-1", "мох44") from the
   * planning page's /roomTypes payload. These are the owner's own short labels
   * shown on the chessboard — far better than the internal `number` code.
   * Best-effort: if it fails we fall back to `number`.
   */
  private async roomNames(): Promise<Map<string, string>> {
    if (this.namesCache) return this.namesCache;
    const map = new Map<string, string>();
    try {
      const text = await this.requestText('get', '/roomTypes');
      if (text) {
        // The page embeds objects like {"id":"1299660",...,"name":"5кр3"}.
        const re = /"id"\s*:\s*"?(\d+)"?[^{}]{0,80}?"name"\s*:\s*"([^"]{1,40})"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const id = m[1]!;
          if (!map.has(id)) {
            try {
              map.set(id, JSON.parse(`"${m[2]}"`));
            } catch {
              map.set(id, m[2]!);
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Bnovo roomNames fetch failed, falling back to codes');
    }
    this.namesCache = map;
    return map;
  }

  private async rooms(): Promise<Map<string, { roomTypeId: number; number: string; name?: string }>> {
    if (this.roomsCache) return this.roomsCache;
    const today = new Date();
    const [{ result }, names] = await Promise.all([
      this.fetchBookings(this.fmt(today), this.fmt(new Date(today.getTime() + 365 * DAY_MS))),
      this.roomNames(),
    ]);
    const map = new Map<string, { roomTypeId: number; number: string; name?: string }>();
    for (const b of result) {
      if (b.room_id && b.dual_roomtype_id) {
        const rid = String(b.room_id);
        // dual_roomtype_id comes back as string for some rooms, number for
        // others — normalize to a number so downstream matching is consistent.
        map.set(rid, { roomTypeId: Number(b.dual_roomtype_id), number: b.number, name: names.get(rid) });
      }
    }
    this.roomsCache = map;
    return map;
  }

  /** ISO date (YYYY-MM-DD) from a Bnovo datetime like "2026-07-20 15:00:00". */
  private isoDay(dt: string): string {
    return dt.slice(0, 10);
  }

  /** Does [aIn,aOut) overlap [bIn,bOut)? All ISO YYYY-MM-DD, checkout exclusive. */
  private overlaps(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
    return aIn < bOut && bIn < aOut;
  }

  async listProperties(): Promise<Property[]> {
    // Room list from a wide bookings window. propertyId = room_id.
    // title preference: real street address (from the presentation popup) >
    // owner's short label ("5кр3") > internal `number` code. Addresses make the
    // agent read like the human owner ("ул. Богомягкова, 6") instead of codes.
    const rooms = await this.rooms();
    await this.enrichAddresses(rooms);
    return [...rooms].map(([room_id, r]) => ({
      id: room_id,
      title: this.prettyTitle(this.presCache.get(String(r.roomTypeId))?.address || r.name || r.number),
      basePrice: 0, // per-date price comes from checkAvailability
      maxGuests: 0,
    }));
  }

  /**
   * Tidy the owner's hand-typed address so several studios at one building read
   * consistently. The owner writes them three different ways — "28 (1)", "28\2",
   * "28 (3)" — which confuses guests picking one. Unify the studio suffix to
   * "(N)" and normalize the "N-я Красноармейская" street form. Token matching in
   * send_apartment_photos strips punctuation anyway, so this is display-only.
   */
  private prettyTitle(raw: string): string {
    let s = raw.trim();
    // "28\2" / "28/2" studio suffix -> "28 (2)" (only a bare 1-2 digit tail,
    // never a real street number like "20/8" which stays as written).
    s = s.replace(/(\d+)\s*[\\](\d{1,2})\b/g, '$1 ($2)');
    // "5 красноармейская" / "5-я красноармейская" -> "5-я Красноармейская"
    s = s.replace(/\b(\d+)(?:-?я)?\s+красноармейская/gi, '$1-я Красноармейская');
    return s;
  }

  /**
   * Fetch presentation data (address + photos) for every distinct room type once
   * per process and warm presCache. Bounded concurrency keeps it civil to Bnovo.
   */
  private async enrichAddresses(
    rooms: Map<string, { roomTypeId: number; number: string; name?: string }>,
  ): Promise<void> {
    if (this.addressesEnriched) return;
    this.addressesEnriched = true; // set first: a partial failure shouldn't loop
    const typeIds = [...new Set([...rooms.values()].map((r) => String(r.roomTypeId)))];
    const pending = typeIds.filter((id) => !this.presCache.has(id));
    const CONCURRENCY = 6;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CONCURRENCY).map((id) => this.presentation(id)));
    }
  }

  /** Guest-facing photos for a room (by room_id). Resolves its room type first. */
  async getPhotos(propertyId: string): Promise<string[]> {
    const rooms = await this.rooms();
    const entry = rooms.get(String(propertyId));
    if (!entry) return [];
    return (await this.presentation(String(entry.roomTypeId))).photos;
  }

  /** Nearby metro stops for a room (by room_id), from its description. */
  async getMetro(propertyId: string): Promise<MetroStop[]> {
    const rooms = await this.rooms();
    const entry = rooms.get(String(propertyId));
    if (!entry) return [];
    return (await this.presentation(String(entry.roomTypeId))).metro ?? [];
  }

  /**
   * Per-room stay prices for the given dates, from
   * POST /roomTypes/getRoomTypeVariation. Body param is `adultCustomerCount`
   * (singular — plural is rejected). placings[0].price is the total for the range.
   *
   * We build TWO indexes because the id relationship is inconsistent across
   * rooms: `byTypeId` (variation roomtype_id -> price) matches when it equals a
   * room's dual_roomtype_id, and `byLabel` (normalized roomtype_name -> price)
   * matches on the human label. checkAvailability tries both.
   */
  private async priceIndex(
    checkIn: string,
    checkOut: string,
    guests: number,
  ): Promise<{
    byTypeId: Map<number, number>;
    byLabel: Map<string, number>;
    capByTypeId: Map<number, number>;
    capByLabel: Map<string, number>;
    resByTypeId: Map<number, RoomRestriction>;
    resByLabel: Map<string, RoomRestriction>;
  }> {
    const byTypeId = new Map<number, number>();
    const byLabel = new Map<string, number>();
    const capByTypeId = new Map<number, number>();
    const capByLabel = new Map<string, number>();
    const resByTypeId = new Map<number, RoomRestriction>();
    const resByLabel = new Map<string, RoomRestriction>();
    // Fetch prices/capacity (variation) and the REAL restriction grid together.
    const [res, restrictions] = await Promise.all([
      this.request<BnovoVariationResponse>('post', '/roomTypes/getRoomTypeVariation', {
        body: JSON.stringify({
          adultCustomerCount: Math.max(1, guests),
          childrenAges: {},
          dateFrom: checkIn,
          dateTo: checkOut,
          planId: Number(this.planId),
          isEarlyArrival: false,
          isLateDeparture: false,
        }),
        headers: { 'content-type': 'application/json' },
      }),
      this.fetchRestrictions(checkIn, checkOut),
    ]);
    for (const v of res?.data?.variation ?? []) {
      const p = v.placings?.[0];
      const label = v.roomtype_name ? this.normLabel(v.roomtype_name) : undefined;

      // Price (unchanged): only index positive prices.
      const price = p?.price;
      if (typeof price === 'number' && price > 0) {
        if (v.roomtype_id != null) byTypeId.set(v.roomtype_id, price);
        if (label) byLabel.set(label, price);
      }

      // Capacity: how many adults the room sleeps (main + extra beds, else adults).
      const cap = this.capacityOf(p);
      if (cap != null) {
        if (v.roomtype_id != null) capByTypeId.set(v.roomtype_id, cap);
        if (label) capByLabel.set(label, cap);
      }

      // Restrictions from the real grid (getRoomTypeVariation's are all-zero for
      // this hotel). Key by roomtype id; also mirror to label so the label-based
      // lookup path resolves too.
      const restriction = v.roomtype_id != null ? restrictions.get(v.roomtype_id) : undefined;
      if (restriction) {
        if (v.roomtype_id != null) resByTypeId.set(v.roomtype_id, restriction);
        if (label) resByLabel.set(label, restriction);
      }
    }
    return { byTypeId, byLabel, capByTypeId, capByLabel, resByTypeId, resByLabel };
  }

  /**
   * True max guests a room sleeps. In getRoomTypeVariation, `adults` is the
   * room's real capacity, while `places.main` just ECHOES the queried guest
   * count (verified: 5кр1 shows adults:2 but main:3 when you ask for 3, and
   * Bnovo also drops it from results entirely when guests exceed adults). So we
   * key capacity off `adults`, not the beds echo. `places.extra` adds sofa beds.
   */
  private capacityOf(p?: {
    adults?: number;
    places?: { main?: number; extra?: number };
  }): number | undefined {
    if (!p) return undefined;
    if (typeof p.adults === 'number' && p.adults > 0) return p.adults + (p.places?.extra ?? 0);
    return undefined;
  }

  /**
   * REAL per-room-type stay restrictions for a window, from the cabinet's
   * price/restrictions grid — the same data the tariff calendar shows.
   *
   * getRoomTypeVariation's date_restrictions come back all-zero for this hotel
   * (min-stay isn't populated there), so it silently allowed 1-2 night bookings
   * where the owner requires 3 (and wrongly blocked the flats that really allow
   * 2). This endpoint is the source of truth: `restrictions[roomTypeId][date] =
   * { minstay, minstay_a, maxstay, closed_arrival, ... }`. We distil each room
   * type to one RoomRestriction for the stay: minStay from the arrival date,
   * maxStay = smallest positive across the window, closedArrival on check-in.
   * Keyed by roomTypeId so it slots straight into the existing resByTypeId path.
   */
  private async fetchRestrictions(
    checkIn: string,
    checkOut: string,
  ): Promise<Map<number, RoomRestriction>> {
    const out = new Map<number, RoomRestriction>();
    // dateFrom uses the cabinet's D-M-YYYY form (as seen in the panel request).
    const [y, m, d] = checkIn.split('-');
    const dateFrom = `${Number(d)}-${Number(m)}-${y}`;
    const res = await this.request<BnovoRestrictionsResponse>(
      'get',
      `/tariff/getPricesAndRestrictionsData?planId=${this.planId}&dateFrom=${dateFrom}&withDynamicPrices=0&parts=restrictions`,
      {},
    );
    const grid = res?.data?.restrictions;
    if (!grid) return out;
    // Arrival-date minimum; window is [checkIn, checkOut).
    for (const [typeIdStr, byDate] of Object.entries(grid)) {
      const typeId = Number(typeIdStr);
      if (!Number.isFinite(typeId) || !byDate) continue;
      const arr = byDate[checkIn];
      const minStay = Math.max(0, Number(arr?.minstay_a || arr?.minstay || 0));
      let maxStay = 0;
      for (const [date, r] of Object.entries(byDate)) {
        if (date < checkIn || date >= checkOut) continue; // only nights of the stay
        const mx = Number(r?.maxstay || 0);
        if (mx > 0) maxStay = maxStay === 0 ? mx : Math.min(maxStay, mx);
      }
      const closedArrival = arr?.closed_arrival === '1' || arr?.closed_arrival === true;
      if (minStay === 0 && maxStay === 0 && !closedArrival) continue;
      out.set(typeId, { minStay, maxStay, closedArrival });
    }
    return out;
  }

  /** Normalize a room label for matching — labels differ in spacing/case across
   * endpoints ("Руб 2" vs "Руб2", "Сад (16)" vs "Сад(16)"). */
  private normLabel(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '').replace(/[()]/g, '');
  }

  async checkAvailability(q: AvailabilityQuery): Promise<AvailabilityResult[]> {
    const nights = this.nights(q.checkIn, q.checkOut);

    // Busy set: bookings/closures overlapping the requested dates.
    const { result, closures } = await this.fetchBookings(q.checkIn, q.checkOut);
    const busy = new Set<string>();
    for (const b of result) {
      if (this.overlaps(this.isoDay(b.real_arrival), this.isoDay(b.real_departure), q.checkIn, q.checkOut)) {
        busy.add(String(b.room_id));
      }
    }
    for (const c of closures) {
      const from = this.ddmmyyyyToIso(c.date_from);
      const to = this.ddmmyyyyToIso(c.date_to);
      if (from && to && this.overlaps(from, to, q.checkIn, q.checkOut)) busy.add(String(c.room_id));
    }

    // Universe of rooms: the full property list (independent of the requested
    // window — otherwise far-future dates with no bookings would yield nothing).
    const all = await this.listProperties();
    const rooms = new Map(all.map((p) => [p.id, p.title]));

    const [dict, prices] = await Promise.all([
      this.rooms(),
      this.priceIndex(q.checkIn, q.checkOut, q.guests),
    ]);

    const ids = q.propertyId ? [q.propertyId] : [...rooms.keys()];
    // Generic lookup against the dual (byTypeId / byLabel) indexes. Price,
    // capacity and restrictions all key the same way, so share one resolver:
    // room-type id first (matches when dual_roomtype_id lines up), then label,
    // number code, and finally the address title. Coerce the type id to a
    // number — Bnovo returns dual_roomtype_id as string for some rooms.
    const lookup = <T>(id: string, title: string, byTypeId: Map<number, T>, byLabel: Map<string, T>): T | undefined => {
      const entry = dict.get(id);
      const fromType = entry?.roomTypeId != null ? byTypeId.get(Number(entry.roomTypeId)) : undefined;
      if (fromType !== undefined) return fromType;
      const fromName = entry?.name ? byLabel.get(this.normLabel(entry.name)) : undefined;
      if (fromName !== undefined) return fromName;
      const fromNumber = entry?.number ? byLabel.get(this.normLabel(entry.number)) : undefined;
      if (fromNumber !== undefined) return fromNumber;
      return byLabel.get(this.normLabel(title));
    };

    const rows = ids.map((id) => {
      const title = rooms.get(id) ?? id;
      const restriction = lookup(id, title, prices.resByTypeId, prices.resByLabel);
      // Metro stops from the warm presentation cache (enrichAddresses ran in
      // listProperties above) — no extra request. Used for metro search + captions.
      const typeId = dict.get(id)?.roomTypeId;
      const metro = typeId != null ? this.presCache.get(String(typeId))?.metro : undefined;
      return {
        propertyId: id,
        title,
        available: !busy.has(id),
        nights,
        totalPrice: lookup(id, title, prices.byTypeId, prices.byLabel),
        capacity: lookup(id, title, prices.capByTypeId, prices.capByLabel),
        minStay: restriction?.minStay,
        maxStay: restriction?.maxStay,
        closedArrival: restriction?.closedArrival,
        metro,
      };
    });

    // A specific room was asked for — return it as-is (no dedup).
    if (q.propertyId) return rows;

    // Drop AVAILABLE rooms that came back with no price for these dates. Bnovo
    // omits the tariff for a room that can't actually be sold on the requested
    // window (over capacity for the party, or no rate loaded) — such a row is
    // NOT a real offer. Leaving it in was the root of a whole class of bugs:
    // it became a phantom "вариант N" next to the real flat at the same address
    // (dedup keys on title|price, and a priceless row gets its own key), the
    // model quoted/offered it, and booking it then failed with "занят" because
    // the underlying physical room was busy or unsellable. No price on the dates
    // = not shown. (Busy rooms keep flowing through so we can still say "занята".)
    const priced = rows.filter((r) => !r.available || r.totalPrice != null);

    // Bnovo lists several physical rooms under the same address (e.g. three
    // "Владимирский проспект 10"). Collapse duplicates so the guest sees each
    // distinct offer once, keyed by (address + price): different prices at one
    // address ARE different flats (Бр16-1 10000 vs Бр16-2 13000) and stay
    // separate; identical ones fold into a single, preferably-available entry.
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of priced) {
      const key = `${r.title}|${r.totalPrice ?? '?'}`;
      const prev = seen.get(key);
      if (!prev || (!prev.available && r.available)) seen.set(key, r);
    }
    // Disambiguate same-address entries (different flats at one address, kept
    // apart by price). Label them "вариант 1/2/…" in a STABLE order (by price)
    // so the same physical flat reads identically in the list and later in the
    // photo captions — otherwise the guest sees "Бронницкая 16" twice with
    // different prices and can't tell which is which. The number is assigned by
    // ascending price so it's deterministic across calls.
    const survivors = [...seen.values()];
    const byTitleCount = new Map<string, number>();
    for (const r of survivors) byTitleCount.set(r.title, (byTitleCount.get(r.title) ?? 0) + 1);
    // For each duplicated title, rank its rows by price to get a stable index.
    const rankByTitle = new Map<string, string[]>(); // title -> propertyIds sorted by price
    for (const title of byTitleCount.keys()) {
      if ((byTitleCount.get(title) ?? 0) <= 1) continue;
      const ranked = survivors
        .filter((r) => r.title === title)
        .sort((a, b) => (a.totalPrice ?? 0) - (b.totalPrice ?? 0))
        .map((r) => r.propertyId);
      rankByTitle.set(title, ranked);
    }
    return survivors.map((r) => {
      const ranked = rankByTitle.get(r.title);
      if (ranked) {
        const idx = ranked.indexOf(r.propertyId) + 1; // 1-based
        return { ...r, title: `${r.title}, вариант ${idx}` };
      }
      return r;
    });
  }

  /**
   * Fresh occupancy check for ONE room over [checkIn, checkOut) — no caching.
   * Queries bookings + closures for the window and tests overlap. Used as the
   * pre-create overbooking guard (force:true would otherwise stack bookings).
   */
  private async isRoomFree(roomId: string, checkIn: string, checkOut: string): Promise<boolean> {
    const { result, closures } = await this.fetchBookings(checkIn, checkOut);
    for (const b of result) {
      if (
        String(b.room_id) === roomId &&
        this.overlaps(this.isoDay(b.real_arrival), this.isoDay(b.real_departure), checkIn, checkOut)
      ) {
        return false;
      }
    }
    for (const c of closures) {
      if (String(c.room_id) !== roomId) continue;
      const from = this.ddmmyyyyToIso(c.date_from);
      const to = this.ddmmyyyyToIso(c.date_to);
      if (from && to && this.overlaps(from, to, checkIn, checkOut)) return false;
    }
    return true;
  }

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    // propertyId is the room_id; Bnovo needs the room_type_id too, which we map
    // from the rooms dictionary (room_id -> dual_roomtype_id). Also accept an
    // explicit "roomTypeId:roomId" form for callers that already know both.
    const raw = String(input.propertyId);
    let roomId: number;
    let roomTypeId: number;
    if (raw.includes(':')) {
      const [t, r] = raw.split(':');
      roomTypeId = Number(t);
      roomId = Number(r);
    } else {
      roomId = Number(raw);
      const rooms = await this.rooms();
      const entry = rooms.get(raw);
      if (!entry) throw new Error(`Bnovo createBooking: unknown room_id ${raw}`);
      roomTypeId = entry.roomTypeId;
    }
    // Guard against overbooking: /booking/add is sent with force:true (Bnovo
    // otherwise rejects perfectly valid same-category bookings), which means it
    // will HappilY create a booking on top of an occupied room. So we re-check
    // occupancy right before creating and refuse if the room is taken for the
    // requested dates. This is the last line of defence against a double-booking
    // between check_availability and create (stale data, races, the model
    // picking a busy room).
    const freshlyFree = await this.isRoomFree(String(roomId), input.checkIn, input.checkOut);
    if (!freshlyFree) {
      throw new Error(
        `Bnovo createBooking refused: room ${roomId} is already booked for ${input.checkIn}..${input.checkOut}`,
      );
    }

    // Capacity + stay-length guards. Bnovo's /booking/add is forced, so it won't
    // enforce these itself — we read the room's own availability (which now
    // carries capacity + minStay/maxStay for the requested window) and refuse a
    // booking that overloads the room or violates the owner's date limits. Last
    // line of defence if the model skipped the check.
    const nightsReq = this.nights(input.checkIn, input.checkOut);
    // Query at guests=1 for the capacity/restriction read: Bnovo omits a room
    // from getRoomTypeVariation when the requested party exceeds its capacity,
    // which would leave `capacity` undefined and silently skip the guard. At
    // guests=1 every room is returned with its true `adults` capacity.
    const [self] = await this.checkAvailability({
      propertyId: String(roomId),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: 1,
    });
    if (self?.capacity && input.guests > self.capacity) {
      throw new Error(
        `Bnovo createBooking refused: room ${roomId} sleeps ${self.capacity}, but ${input.guests} guests requested`,
      );
    }
    if (self?.minStay && nightsReq < self.minStay) {
      throw new Error(
        `Bnovo createBooking refused: minimum stay for ${input.checkIn} is ${self.minStay} nights, ${nightsReq} requested`,
      );
    }
    if (self?.maxStay && nightsReq > self.maxStay) {
      throw new Error(
        `Bnovo createBooking refused: maximum stay for ${input.checkIn} is ${self.maxStay} nights, ${nightsReq} requested`,
      );
    }
    if (self?.closedArrival) {
      throw new Error(`Bnovo createBooking refused: arrival is closed on ${input.checkIn} for room ${roomId}`);
    }

    const parts = input.guestName.trim().split(/\s+/);
    const surname = parts[0] ?? input.guestName;
    const name = parts.slice(1).join(' ') || surname;
    const nights = this.nights(input.checkIn, input.checkOut);
    const pricePerNight = nights > 0 ? Math.round(input.totalPrice / nights) : input.totalPrice;

    const id = await this.createBookingRaw({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomTypeId,
      roomId,
      guests: input.guests,
      name,
      surname,
      phone: input.guestPhone ?? '',
      price: pricePerNight,
      notes: `AI-manager ${input.idempotencyKey}`,
    });
    if (!id) throw new Error('Bnovo createBooking failed');
    return {
      id,
      propertyId: input.propertyId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      guestName: input.guestName,
      status: 'confirmed',
      totalPrice: input.totalPrice,
    };
  }

  /** Low-level POST /booking/add with explicit Bnovo ids. Returns booking id. */
  async createBookingRaw(p: {
    checkIn: string;
    checkOut: string;
    roomTypeId: number;
    roomId: number;
    guests: number;
    name: string;
    surname: string;
    phone: string;
    price: number;
    notes?: string;
  }): Promise<string | null> {
    // Bnovo needs numeric ids (dictionary yields them as strings) — coerce.
    const roomTypeId = Number(p.roomTypeId);
    const roomId = Number(p.roomId);

    // room_types keyed by each night's date (checkIn .. checkOut exclusive).
    const perNight: Record<string, unknown> = {};
    const start = Date.parse(p.checkIn);
    const end = Math.max(Date.parse(p.checkOut), start + DAY_MS); // at least one night
    for (let t = start; t < end; t += DAY_MS) {
      perNight[this.fmt(new Date(t))] = {
        room_type_id: roomTypeId,
        real_room_type_id: roomTypeId,
        room_id: roomId,
        adults: p.guests,
        children: 0,
        price: p.price,
        discount_amount: 0,
        discount_type: 0,
      };
    }

    const body = {
      date_from: p.checkIn,
      date_to: p.checkOut,
      arrival_time: this.arrivalTime,
      departure_time: this.departureTime,
      name: p.name,
      surname: p.surname,
      phone: p.phone,
      email: '',
      notes: p.notes ?? '',
      customer_id: '',
      customers_tags: [],
      marketing: { [this.marketingSourceId]: 0 },
      agency_id: null,
      supplier_id: null,
      group_name: '',
      group_id: '',
      force: true,
      room_types: {
        '1': {
          services: {},
          included_services: {},
          room_types: perNight,
          extra_charges: {},
          people: { extra_beds: 0, main_beds: 0, max_adults: 0, min_adults: 0 },
          discount_reason_id: '',
          discount_reason: '',
          plan_id: this.planId,
          adults: String(p.guests),
          children: '0',
        },
      },
    };
    const res = await this.request<{ result: string; first_booking_id?: string }>('post', '/booking/add', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    if (!res || res.result !== 'success' || !res.first_booking_id) {
      logger.error({ res }, 'Bnovo /booking/add did not succeed');
      return null;
    }
    return res.first_booking_id;
  }

  /**
   * Cancel a booking via POST /bookings/changeStatus (new_status_id=2).
   * `bookingNumber` is Bnovo's internal code (e.g. "5HYA5-310726"); if omitted
   * we look it up from the bookings list. cancelReasonId is account-specific.
   */
  async cancelBooking(
    bookingId: string,
    opts: { bookingNumber?: string; cancelReasonId?: number } = {},
  ): Promise<boolean> {
    let bookingNumber = opts.bookingNumber;
    if (!bookingNumber) {
      // Search a wide window for this booking to recover its number.
      const today = new Date();
      const { result } = await this.fetchBookings(
        this.fmt(new Date(today.getTime() - 30 * DAY_MS)),
        this.fmt(new Date(today.getTime() + 730 * DAY_MS)),
      );
      bookingNumber = result.find((b) => b.booking_id === bookingId)?.number;
    }
    const body = {
      booking_id: bookingId,
      new_status_id: '2', // 2 = cancelled (1 = new)
      cancel_reason_id: opts.cancelReasonId ?? 40503,
      concierge_checkout: 0,
      booking_number: bookingNumber ?? '',
      is_checkin: 0,
      fine: '0',
    };
    const res = await this.request<{ result?: string } | null>('post', '/bookings/changeStatus', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    // changeStatus returns success-ish JSON; treat non-null 200 as done.
    logger.info({ bookingId, res }, 'Bnovo cancelBooking');
    return res !== null;
  }

  /**
   * The online-invoice id Bnovo auto-creates for a booking. Prepayment for the
   * first night is generated automatically; we read it from getInvoices
   * (data.invoices.online[0]). Returns null if none exists yet.
   */
  private async firstInvoiceId(bookingId: string): Promise<number | null> {
    const res = await this.request<{
      result: string;
      data?: { invoices?: { online?: Array<{ id?: number }> } };
    }>('post', '/booking/getInvoices', {
      body: JSON.stringify({ bookingId }),
      headers: { 'content-type': 'application/json' },
    });
    return res?.data?.invoices?.online?.[0]?.id ?? null;
  }

  async getPaymentLink(bookingId: string): Promise<PaymentLink> {
    // Bnovo auto-creates an online invoice (first-night prepayment). Its public
    // pay page lives at payment.bnovo.ru; the cabinet hands out that URL via
    // /invoices/invoice_pdf_link?invoice_id=... (the "Поделиться" button).
    const invoiceId = await this.firstInvoiceId(bookingId);
    if (!invoiceId) {
      throw new Error(`Bnovo getPaymentLink: no online invoice for booking ${bookingId}`);
    }
    const res = await this.request<{ result: string; url?: string }>(
      'get',
      `/invoices/invoice_pdf_link?invoice_id=${invoiceId}`,
    );
    const url = res?.url;
    if (!url) throw new Error(`Bnovo getPaymentLink: no url for invoice ${invoiceId}`);
    return { bookingId, url };
  }

  /**
   * Has the guest paid anything on this booking? The invoice page exposes a
   * hidden `has_not_null_payments` flag (0 = nothing paid, 1 = a payment
   * exists). We read the page and parse that — no JSON endpoint exposes it.
   */
  async isBookingPaid(bookingId: string): Promise<boolean> {
    const html = await this.requestText('get', `/booking/invoices/${bookingId}/`);
    if (!html) return false;
    const m = html.match(/has_not_null_payments"[^>]*value="(\d+)"/);
    return m ? Number(m[1]) > 0 : false;
  }

  async getCalendarData(from: string, to: string): Promise<import('./types.js').CalendarData> {
    const [{ result, closures }, properties] = await Promise.all([
      this.fetchBookings(from, to),
      this.listProperties(),
    ]);

    // Attach photos for the properties
    const propsWithPhotos = await Promise.all(
      properties.map(async (p) => {
        const photos = (await this.getPhotos(p.id)) || [];
        const desc = await this.getDescription(p.id);
        const address = this.parseAddress(desc ?? undefined) || p.title;
        return {
          id: p.id,
          title: p.title,
          address,
          photos,
          price: p.basePrice || undefined,
        };
      })
    );

    const bookings = result.map((b) => ({
      id: b.booking_id,
      propertyId: String(b.room_id),
      roomTypeId: b.dual_roomtype_id ? Number(b.dual_roomtype_id) : undefined,
      guestName: [b.surname, b.name].filter(Boolean).join(' ').trim() || 'Гость',
      guestPhone: b.phone || undefined,
      checkIn: this.isoDay(b.real_arrival),
      checkOut: this.isoDay(b.real_departure),
      amount: b.amount ? Number(b.amount) : undefined,
      status: b.status_name || String(b.status_id),
    }));

    const closureItems = closures
      .map((c) => {
        const checkIn = this.ddmmyyyyToIso(c.date_from);
        const checkOut = this.ddmmyyyyToIso(c.date_to);
        if (!checkIn || !checkOut) return null;
        return {
          propertyId: String(c.room_id),
          checkIn,
          checkOut,
          reason: c.reason || 'Закрыто',
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return {
      from,
      to,
      properties: propsWithPhotos,
      bookings,
      closures: closureItems,
    };
  }

  async getCheckouts(isoDate: string): Promise<Checkout[]> {
    // Look at a small window around the date and keep departures on that day.
    const { result } = await this.fetchBookings(isoDate, this.fmt(new Date(Date.parse(isoDate) + DAY_MS)));
    return result
      .filter((b) => this.isoDay(b.real_departure) === isoDate)
      .map((b) => ({
        bookingId: b.booking_id,
        propertyId: String(b.room_id),
        propertyTitle: b.number,
        checkOutDate: isoDate,
        guestName: [b.surname, b.name].filter(Boolean).join(' ').trim(),
      }));
  }

  // --- helpers ---
  private nights(checkIn: string, checkOut: string): number {
    return Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS));
  }
  /** Date -> "YYYY-MM-DD" (UTC-safe for whole-day values). */
  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
  /** "DD-MM-YYYY" -> "YYYY-MM-DD" (Bnovo closures use DD-MM-YYYY). */
  private ddmmyyyyToIso(s: string): string | null {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
}
