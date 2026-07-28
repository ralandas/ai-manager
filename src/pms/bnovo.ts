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
 * Bnovo PMS connector — STUB.
 *
 * Bnovo's official API is read-only on the free tier and gated behind a paid
 * tariff otherwise, with no clear booking-creation endpoint — so (per the
 * client's setup) the real integration will be reverse-engineered from the web
 * cabinet, like RealtyCalendar. This stub encodes what's already known and
 * leaves the reverse-engineered calls as TODO to fill in once we have access.
 *
 * Known from the official docs:
 *   - base:  https://api.pms.bnovo.ru
 *   - auth:  POST /api/v1/auth  { id, password } -> { access_token } (JWT, 24h)
 *   - v1 (free): GET /bookings, GET /bookings/{id}  (read-only)
 *   - v2 (paid): availability, payments, booking updates, webhooks
 */
export interface BnovoCreds {
  accountId: string;
  password: string;
  baseUrl?: string;
  /** If reverse-engineering the web cabinet: session cookie + UA. */
  cookie?: string;
  userAgent?: string;
}

const NOT_READY = 'Bnovo-коннектор ещё не подключён (ожидается доступ к кабинету для реверса)';

export class BnovoClient implements PmsConnector {
  private readonly base: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly creds: BnovoCreds) {
    if (!creds.accountId || !creds.password) {
      throw new Error('Bnovo requires accountId and password');
    }
    this.base = creds.baseUrl ?? 'https://api.pms.bnovo.ru';
  }

  /**
   * Auth is the one piece the docs specify precisely; cache the JWT for ~23h.
   * (Read paths may use this; write/availability will likely need the reversed
   * web-cabinet calls instead — filled in on access.)
   */
  private async authToken(): Promise<string | null> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    try {
      const res = await fetch(`${this.base}/api/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.creds.accountId, password: this.creds.password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        logger.error({ status: res.status }, 'Bnovo auth failed');
        return null;
      }
      const data = (await res.json()) as { access_token?: string };
      if (!data.access_token) return null;
      this.token = data.access_token;
      this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
      return this.token;
    } catch (err) {
      logger.error({ err }, 'Bnovo auth threw');
      return null;
    }
  }

  // --- PmsConnector: stubbed until reverse-engineered on real access ---

  async listProperties(): Promise<Property[]> {
    logger.warn(NOT_READY);
    return [];
  }

  async checkAvailability(_q: AvailabilityQuery): Promise<AvailabilityResult[]> {
    logger.warn(NOT_READY);
    return [];
  }

  async createBooking(_input: CreateBookingInput): Promise<Booking> {
    throw new Error(NOT_READY);
  }

  async getPaymentLink(_bookingId: string): Promise<PaymentLink> {
    throw new Error(NOT_READY);
  }

  async getCheckouts(_isoDate: string): Promise<Checkout[]> {
    logger.warn(NOT_READY);
    return [];
  }
}
