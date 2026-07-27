import { config } from '../config.js';
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
 * Realty Calendar PMS connector.
 *
 * RC has no official API; endpoints and auth were reverse-engineered from the
 * web client and the reference integration (rc_integration_export). Auth is two
 * headers: `x-user-token` (long-lived) and `Cookie`. The server rejects requests
 * without a User-Agent, so we always send one.
 *
 * Date formats differ by endpoint (verified against live responses):
 *  - calendar (/v2/event_calendars) uses YYYY-MM-DD
 *  - bookings list (/requests_bookings) compares DD.MM.YYYY
 * The business timezone is GMT+9 (Asia/Tokyo), matching the reference code.
 */
export class RealtyCalendarClient implements PmsConnector {
  private readonly base = config.RC_BASE_URL;

  constructor() {
    if (!config.RC_USER_TOKEN) throw new Error('RC_USER_TOKEN is required for realtycalendar');
  }

  private headers(): Record<string, string> {
    return {
      'x-user-token': config.RC_USER_TOKEN!,
      Cookie: config.RC_COOKIE ?? '',
      'User-Agent': config.RC_USER_AGENT,
      Accept: 'application/json',
      'content-type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = `${this.base}${endpoint}`;
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      logger.info({ url, method, status: res.status }, 'RC request');
      if (!res.ok) {
        logger.error({ url, status: res.status, body: text.slice(0, 500) }, 'RC request failed');
        return null;
      }
      return text.trim() ? (JSON.parse(text) as T) : null;
    } catch (err) {
      logger.error({ url, err }, 'RC request threw');
      return null;
    }
  }

  async listProperties(): Promise<Property[]> {
    const data = await this.request<RcApartmentsResponse>('get', '/v2/apartments');
    if (!data) return [];
    return data.apartments
      .filter((a) => !a.archive)
      .map((a) => ({
        id: String(a.id),
        title: a.title,
        basePrice: a.prices?.amount ?? 0,
        // RC doesn't expose max guests on this endpoint; default generously.
        maxGuests: 6,
      }));
  }

  async checkAvailability(q: AvailabilityQuery): Promise<AvailabilityResult[]> {
    const props = await this.listProperties();
    const pool = q.propertyId ? props.filter((p) => p.id === q.propertyId) : props;
    if (pool.length === 0) return [];

    const ids = pool.map((p) => p.id).join(',');
    const ep =
      `/v2/event_calendars/?begin_date=${q.checkIn}&end_date=${q.checkOut}` +
      `&statuses[]=booked&statuses[]=canceled&statuses[]=request&apartment_ids=${ids}`;
    const data = await this.request<RcCalendarResponse>('get', ep);
    const byId = new Map((data?.items ?? []).map((it) => [String(it.apartment_id), it]));

    const nights = this.nights(q.checkIn, q.checkOut);
    return pool.map((p) => {
      const item = byId.get(p.id);
      // An apartment with no overlapping events in the window is free.
      const hasConflict = (item?.events ?? []).some(
        (e) => e.status !== 'canceled' && e.begin_date < q.checkOut && q.checkIn < e.end_date,
      );
      return {
        propertyId: p.id,
        title: p.title,
        available: !hasConflict && nights > 0,
        nights,
        totalPrice: p.basePrice * nights,
      };
    });
  }

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    // Verified live: POST /v2/event_calendars, body wrapped in `event_calendar`,
    // dates DD.MM.YYYY. Response echoes dates back as YYYY-MM-DD.
    const body = {
      event_calendar: {
        apartment_id: Number(input.propertyId),
        begin_date: this.toRcDate(input.checkIn),
        end_date: this.toRcDate(input.checkOut),
        status: 'booked',
        amount: input.totalPrice,
        notes: `auto (idem:${input.idempotencyKey})`,
        client: { fio: input.guestName, phone: input.guestPhone ?? '' },
      },
    };
    const created = await this.request<RcEventCalendar>('post', '/v2/event_calendars', body);
    if (!created?.id) throw new Error('RC createBooking: empty/invalid response');
    return this.toBooking(created, input.propertyId);
  }

  async getPaymentLink(bookingId: string): Promise<PaymentLink> {
    const ep = `/v2/event_calendars/${bookingId}/deposits`;
    // Try existing deposit first (GET), then create one (POST) — same as reference.
    const existing = await this.request<RcDeposit>('get', ep);
    if (existing?.payment_link) return { bookingId, url: existing.payment_link };

    const created = await this.request<RcDeposit>('post', ep, {
      note: 'auto',
      amount: config.RC_DEFAULT_DEPOSIT,
      type: 'get_link',
    });
    if (!created?.payment_link) throw new Error('RC getPaymentLink: no payment_link returned');
    return { bookingId, url: created.payment_link };
  }

  async getCheckouts(isoDate: string): Promise<Checkout[]> {
    // Query the calendar for that single day and collect events whose end_date
    // equals the target date (a checkout). end_date is exclusive of the stay.
    const props = await this.listProperties();
    if (props.length === 0) return [];
    const titles = new Map(props.map((p) => [p.id, p.title]));
    const ids = props.map((p) => p.id).join(',');
    const ep =
      `/v2/event_calendars/?begin_date=${isoDate}&end_date=${isoDate}` +
      `&statuses[]=booked&statuses[]=request&apartment_ids=${ids}`;
    const data = await this.request<RcCalendarResponse>('get', ep);

    const checkouts: Checkout[] = [];
    for (const item of data?.items ?? []) {
      for (const e of item.events ?? []) {
        if (e.end_date === isoDate && e.status !== 'canceled') {
          const pid = String(item.apartment_id);
          checkouts.push({
            bookingId: String(e.id),
            propertyId: pid,
            propertyTitle: titles.get(pid) ?? pid,
            checkOutDate: e.end_date,
            guestName: e.client?.fio ?? 'Гость',
          });
        }
      }
    }
    return checkouts;
  }

  // --- helpers ---

  private nights(checkIn: string, checkOut: string): number {
    const ms = Date.parse(checkOut) - Date.parse(checkIn);
    return Math.max(0, Math.round(ms / 86_400_000));
  }

  /** YYYY-MM-DD -> DD.MM.YYYY (RC booking date format). */
  private toRcDate(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  private toBooking(e: RcEventCalendar, propertyId: string): Booking {
    return {
      id: String(e.id),
      propertyId,
      checkIn: e.begin_date,
      checkOut: e.end_date,
      guests: 1,
      guestName: e.client?.fio ?? '',
      status: e.status === 'booked' ? 'confirmed' : 'pending',
      totalPrice: e.amount ?? 0,
    };
  }
}

// --- RC response shapes (subset we use) ---

interface RcApartmentsResponse {
  apartments: Array<{
    id: number;
    title: string;
    archive: boolean;
    prices?: { amount?: number; weekend?: { amount?: number } };
  }>;
}

interface RcEvent {
  id: number;
  begin_date: string; // YYYY-MM-DD in calendar responses
  end_date: string;
  status: string;
  amount?: number;
  client?: { fio?: string; phone?: string };
}

interface RcCalendarResponse {
  items: Array<{ apartment_id: number; events: RcEvent[] }>;
}

interface RcEventCalendar {
  id: number;
  begin_date: string;
  end_date: string;
  status: string;
  amount?: number;
  client?: { fio?: string; phone?: string };
}

interface RcDeposit {
  payment_link?: string;
}
