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
 * In-memory fake PMS. Lets us build and test the whole agent, housekeeping and
 * forecast flows before Realty Calendar is reverse-engineered. Swap for the real
 * connector by setting PMS_PROVIDER=realtycalendar — nothing else changes.
 */
export class StubPms implements PmsConnector {
  private readonly properties: Property[] = [
    { id: 'apt-1', title: 'Студия, центр, 5 этаж', basePrice: 15000, maxGuests: 2 },
    { id: 'apt-2', title: '2-комнатная, у реки', basePrice: 25000, maxGuests: 4 },
  ];
  private readonly bookings = new Map<string, Booking>();
  /** idempotencyKey -> bookingId, so a retried createBooking returns the same row. */
  private readonly idempotency = new Map<string, string>();
  private seq = 1;

  async listProperties(): Promise<Property[]> {
    return this.properties;
  }

  private nights(checkIn: string, checkOut: string): number {
    const ms = Date.parse(checkOut) - Date.parse(checkIn);
    return Math.max(0, Math.round(ms / 86_400_000));
  }

  async checkAvailability(q: AvailabilityQuery): Promise<AvailabilityResult[]> {
    const nights = this.nights(q.checkIn, q.checkOut);
    const pool = q.propertyId
      ? this.properties.filter((p) => p.id === q.propertyId)
      : this.properties;

    return pool
      .filter((p) => p.maxGuests >= q.guests)
      .map((p) => {
        const overlaps = [...this.bookings.values()].some(
          (b) =>
            b.propertyId === p.id &&
            b.status !== 'cancelled' &&
            b.checkIn < q.checkOut &&
            q.checkIn < b.checkOut,
        );
        return {
          propertyId: p.id,
          title: p.title,
          available: !overlaps && nights > 0,
          nights,
          totalPrice: p.basePrice * nights,
        };
      });
  }

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      logger.info({ key: input.idempotencyKey }, 'stub PMS: idempotent createBooking hit');
      return this.bookings.get(existingId)!;
    }

    const id = `bk-${this.seq++}`;
    const booking: Booking = {
      id,
      propertyId: input.propertyId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      guestName: input.guestName,
      status: 'pending',
      totalPrice: input.totalPrice,
    };
    this.bookings.set(id, booking);
    this.idempotency.set(input.idempotencyKey, id);
    logger.info({ id }, 'stub PMS: booking created');
    return booking;
  }

  async getPaymentLink(bookingId: string): Promise<PaymentLink> {
    if (!this.bookings.has(bookingId)) throw new Error(`unknown booking ${bookingId}`);
    return { bookingId, url: `https://pay.example/stub/${bookingId}` };
  }

  async getCheckouts(isoDate: string): Promise<Checkout[]> {
    return [...this.bookings.values()]
      .filter((b) => b.checkOut === isoDate && b.status !== 'cancelled')
      .map((b) => ({
        bookingId: b.id,
        propertyId: b.propertyId,
        propertyTitle: this.properties.find((p) => p.id === b.propertyId)?.title ?? b.propertyId,
        checkOutDate: b.checkOut,
        guestName: b.guestName,
      }));
  }
}
