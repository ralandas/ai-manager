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
  /** Session cookie value: `SID=<value>`. This is the whole auth. */
  sid: string;
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

  constructor(private readonly creds: BnovoCreds) {
    if (!creds.sid) throw new Error('Bnovo requires the SID session cookie');
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
      Cookie: `SID=${this.creds.sid}`,
      'User-Agent': this.ua,
      Accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      Origin: this.base,
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    opts: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<T | null> {
    const url = `${this.base}${endpoint}`;
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(opts.headers),
        body: opts.body,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      logger.info({ url, method, status: res.status }, 'Bnovo request');
      if (!res.ok) {
        logger.error({ url, status: res.status, body: text.slice(0, 500) }, 'Bnovo request failed');
        return null;
      }
      return text.trim() ? (JSON.parse(text) as T) : null;
    } catch (err) {
      logger.error({ url, err }, 'Bnovo request threw');
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

  /** ISO date (YYYY-MM-DD) from a Bnovo datetime like "2026-07-20 15:00:00". */
  private isoDay(dt: string): string {
    return dt.slice(0, 10);
  }

  /** Does [aIn,aOut) overlap [bIn,bOut)? All ISO YYYY-MM-DD, checkout exclusive. */
  private overlaps(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
    return aIn < bOut && bIn < aOut;
  }

  async listProperties(): Promise<Property[]> {
    // Derive the room list from a wide bookings window (the cabinet has no clean
    // "rooms" endpoint captured yet). Human-friendly names need the rooms
    // dictionary; until then the internal `number` code is used as the title.
    const today = new Date();
    const from = this.fmt(today);
    const to = this.fmt(new Date(today.getTime() + 365 * DAY_MS));
    const { result } = await this.fetchBookings(from, to);
    const byRoom = new Map<number, string>();
    for (const b of result) if (b.room_id) byRoom.set(b.room_id, b.number);
    return [...byRoom].map(([room_id, number]) => ({
      id: String(room_id),
      title: number,
      basePrice: 0, // per-date price comes from checkAvailability
      maxGuests: 0,
    }));
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
      totalPrice: 0, // price enrichment via /tariff/getAvailable is a follow-up
    }));
  }

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    // Bnovo /booking/add needs the real room_type_id, which differs from room_id.
    // The map room_id -> room_type_id comes from the rooms dictionary (not yet
    // captured). Until then propertyId must be "roomTypeId:roomId"; a bare id is
    // rejected loudly rather than silently creating a wrong booking.
    const [roomTypeStr, roomStr] = String(input.propertyId).split(':');
    const roomTypeId = Number(roomTypeStr);
    const roomId = Number(roomStr ?? roomTypeStr);
    if (!roomStr) {
      throw new Error(
        'Bnovo createBooking: propertyId must be "roomTypeId:roomId" (rooms dictionary not yet mapped)',
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
    // room_types keyed by each night's date -> room assignment.
    const perNight: Record<string, unknown> = {};
    for (let t = Date.parse(p.checkIn); t < Date.parse(p.checkOut) || t === Date.parse(p.checkIn); t += DAY_MS) {
      perNight[this.fmt(new Date(t))] = {
        room_type_id: p.roomTypeId,
        real_room_type_id: p.roomTypeId,
        room_id: p.roomId,
        adults: p.guests,
        children: 0,
        price: p.price,
        discount_amount: 0,
        discount_type: 0,
      };
      if (Date.parse(p.checkOut) <= Date.parse(p.checkIn)) break; // same-day guard
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

  async getPaymentLink(_bookingId: string): Promise<PaymentLink> {
    // Bnovo cabinet has no self-serve payment-link endpoint in what we reversed.
    // Payment for Bnovo owners is handled out-of-band (owner's own flow).
    throw new Error('Bnovo: ссылка на оплату не поддерживается кабинетом (оплата вне PMS)');
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
