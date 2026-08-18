/**
 * PMS abstraction for Realty Calendar. Realty Calendar has no official API, so
 * the real implementation will be built by reverse-engineering the web client's
 * network calls. Everything dirty (auth cookies/tokens, endpoint quirks, request
 * chaining) lives behind this interface — the agent only sees these methods.
 */

export interface Property {
  id: string;
  title: string;
  /** Nightly base price in currency minor units (e.g. tenge). */
  basePrice: number;
  maxGuests: number;
}

export interface AvailabilityQuery {
  propertyId?: string;
  /** ISO date YYYY-MM-DD, inclusive. */
  checkIn: string;
  /** ISO date YYYY-MM-DD, exclusive (checkout day). */
  checkOut: string;
  guests: number;
}

export interface AvailabilityResult {
  propertyId: string;
  title: string;
  available: boolean;
  nights: number;
  /** Total price for the stay, if the PMS exposes it (omitted when unknown). */
  totalPrice?: number;
  /** Max guests the room sleeps (from the PMS), if known. Filter/guard on this. */
  capacity?: number;
  /** Minimum nights required for THIS arrival date (0/undefined = no limit). */
  minStay?: number;
  /** Maximum nights allowed over the window (0/undefined = no limit). */
  maxStay?: number;
  /** True if arrival is closed on the requested check-in date. */
  closedArrival?: boolean;
  /** Nearby metro stops parsed from the owner's description (for search + captions). */
  metro?: Array<{ station: string; walkMin?: number }>;
}

export interface CreateBookingInput {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestName: string;
  guestPhone?: string;
  totalPrice: number;
  /** Caller-supplied key so retries never create a duplicate booking. */
  idempotencyKey: string;
}

export interface Booking {
  id: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestName: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  totalPrice: number;
}

export interface PaymentLink {
  bookingId: string;
  url: string;
}

/** A checkout happening on a given date — feeds the housekeeping module. */
export interface Checkout {
  bookingId: string;
  propertyId: string;
  propertyTitle: string;
  checkOutDate: string;
  guestName: string;
}

export interface CalendarBookingItem {
  id: string;
  propertyId: string;
  roomTypeId?: number;
  guestName: string;
  guestPhone?: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  amount?: number;
  status: string;
  isPaid?: boolean;
}

export interface CalendarClosureItem {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  reason?: string;
}

export interface CalendarData {
  from: string;
  to: string;
  properties: Array<{
    id: string;
    title: string;
    address?: string;
    photos: string[];
    price?: number;
  }>;
  bookings: CalendarBookingItem[];
  closures: CalendarClosureItem[];
}

export interface PmsConnector {
  listProperties(): Promise<Property[]>;
  checkAvailability(q: AvailabilityQuery): Promise<AvailabilityResult[]>;
  createBooking(input: CreateBookingInput): Promise<Booking>;
  getPaymentLink(bookingId: string): Promise<PaymentLink>;
  /** Checkouts scheduled for a specific ISO date (used by nightly forecast). */
  getCheckouts(isoDate: string): Promise<Checkout[]>;
  /** Photo URLs for a property, pulled from the PMS itself (optional). */
  getPhotos?(propertyId: string): Promise<string[]>;
  /** Full calendar chessboard (bookings + closures + properties). */
  getCalendarData?(from: string, to: string): Promise<CalendarData>;
  /** Whether the booking has any payment recorded (optional; PMS-specific). */
  isBookingPaid?(bookingId: string): Promise<boolean>;
  /** Cancel a booking (optional; PMS-specific). Returns true on success. */
  cancelBooking?(bookingId: string): Promise<boolean>;
  /** Full free-text listing description (amenities/rules), if the PMS has one. */
  getDescription?(propertyId: string): Promise<string | null>;
  /** Nearby metro stops for a property, if the PMS/description exposes them. */
  getMetro?(propertyId: string): Promise<Array<{ station: string; walkMin?: number }>>;
}

