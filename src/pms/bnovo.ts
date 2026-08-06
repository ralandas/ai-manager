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
  /** room_type_id -> presentation (address + photos), cached per process. */
  private presCache = new Map<string, { address?: string; photos: string[] }>();
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
  private async presentation(roomTypeId: string): Promise<{ address?: string; photos: string[] }> {
    const key = String(roomTypeId);
    const cached = this.presCache.get(key);
    if (cached) return cached;
    let out: { address?: string; photos: string[] } = { photos: [] };
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
        out = { address: this.parseAddress(resp.data.pms_room_type?.description), photos };
      }
    } catch (err) {
      logger.warn({ roomTypeId, err }, 'Bnovo presentation fetch failed');
    }
    this.presCache.set(key, out);
    return out;
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
        map.set(rid, { roomTypeId: b.dual_roomtype_id, number: b.number, name: names.get(rid) });
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
      title: this.presCache.get(String(r.roomTypeId))?.address || r.name || r.number,
      basePrice: 0, // per-date price comes from checkAvailability
      maxGuests: 0,
    }));
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

    const ids = q.propertyId ? [q.propertyId] : [...rooms.keys()];
    return ids.map((id) => ({
      propertyId: id,
      title: rooms.get(id) ?? id,
      available: !busy.has(id),
      nights,
      // Price isn't reversed for Bnovo yet — omit it (0 would read as "0 ₽").
      // The agent must not quote a number it doesn't have.
      totalPrice: undefined,
    }));
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
