/**
 * workflows/booking/booking — the WF-2 Booking Service domain logic (design WF-2).
 *
 * Pure, cloud-decoupled booking logic behind Requirement 14:
 *
 *   - **R14.1 — tenant-scoped creation.** A booking is created scoped to the
 *     action's `tenantId`. The `tenantId` arrives already derived from a
 *     Validated_Session (the WF-1 orchestrator propagates it into every state
 *     input — design Property 7); this module never re-derives it from the
 *     client payload.
 *   - **R14.2 — tenant-partitioned persistence.** The booking is persisted to
 *     the DM-2 single table through the shared {@link TenantPersistence} wrapper,
 *     so the written item carries `PK = TENANT#<tenantId>`, `entityType =
 *     'Booking'`, and `SK = BOOKING#<id>` (design "Data Models"; Property 3).
 *     Tenant logic is NOT re-implemented here — it is reused from
 *     `data/persistence`.
 *   - **R14.3 — unavailable slots create nothing.** If the requested slot is
 *     unavailable, an `unavailable` outcome is returned and NO item is persisted
 *     (design Property 17). Availability is decided by an injected
 *     {@link SlotAvailabilityChecker} seam so a real calendar integration can be
 *     dropped in without touching this logic.
 *
 * The function takes its collaborators by injection ({@link CreateBookingDeps}),
 * so it is exercised in tests with a fake writer + availability checker and zero
 * AWS coupling.
 *
 * _Requirements: 14.1, 14.2, 14.3_
 */

import {
  EntityType,
  PersistedItem,
  TenantPersistence,
} from '../../data/persistence';

/** The entity discriminator for a booking record in DM-2. */
export const BOOKING_ENTITY_TYPE: EntityType = 'Booking';

/** Sort-key prefix for a booking record: `BOOKING#<id>`. */
export const BOOKING_SK_PREFIX = 'BOOKING#';

/** Build the DM-2 sort key for a booking: `BOOKING#<id>`. */
export function bookingSortKey(bookingId: string): string {
  if (typeof bookingId !== 'string' || bookingId.length === 0) {
    throw new Error('bookingSortKey requires a non-empty booking id.');
  }
  return `${BOOKING_SK_PREFIX}${bookingId}`;
}

/**
 * A normalized, tenant-scoped booking request handed to the service. The
 * `slot` identifies the requested appointment slot (shape owned by the imported
 * contract — treated opaquely here); `details` is the rest of the booking
 * payload (service, customer contact, notes) passed through untouched.
 */
export interface BookingRequest {
  /** Operative tenant — derived from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** The requested appointment slot identifier (e.g. an ISO-8601 start time). */
  readonly slot: string;
  /** Remaining booking payload (service, contact, notes …). */
  readonly details?: Record<string, unknown>;
  /**
   * Optional caller-supplied booking id. When absent the service mints one via
   * the injected id generator, so a deterministic id can be used in tests.
   */
  readonly bookingId?: string;
}

/** A successfully created booking. */
export interface BookedOutcome {
  readonly status: 'booked';
  /** The fully-formed, tenant-partitioned item that was persisted. */
  readonly booking: PersistedItem;
}

/** The requested slot was unavailable; nothing was persisted. */
export interface UnavailableOutcome {
  readonly status: 'unavailable';
  readonly tenantId: string;
  readonly slot: string;
}

/** The result of a booking attempt (design WF-2: `Booking | Unavailable`). */
export type BookingOutcome = BookedOutcome | UnavailableOutcome;

/**
 * Decides whether a requested slot can be booked for a tenant. This is the seam
 * a real calendar/availability integration plugs into; the booking logic only
 * cares about the boolean answer (design WF-2; Requirement 14.3).
 */
export interface SlotAvailabilityChecker {
  isAvailable(tenantId: string, slot: string): Promise<boolean> | boolean;
}

/** Thrown when a booking request is structurally invalid (e.g. missing slot). */
export class BookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingValidationError';
    Object.setPrototypeOf(this, BookingValidationError.prototype);
  }
}

/** Collaborators injected into {@link createBooking}. */
export interface CreateBookingDeps {
  /** Shared DM-2 persistence wrapper — enforces `PK = TENANT#<tenantId>`. */
  readonly persistence: TenantPersistence;
  /** Decides slot availability (design Property 17 seam). */
  readonly availability: SlotAvailabilityChecker;
  /** Booking-id generator; defaults to a random UUID. */
  readonly newBookingId?: () => string;
}

/**
 * Create a booking for a tenant.
 *
 *  1. Validate the request carries a tenant and a slot (a missing slot is a
 *     structural error, not an "unavailable" outcome).
 *  2. Ask the availability checker whether the slot is bookable. If NOT, return
 *     an `unavailable` outcome and persist nothing (R14.3 / Property 17).
 *  3. Otherwise persist a tenant-partitioned `Booking` item via the shared
 *     {@link TenantPersistence} wrapper (`PK = TENANT#<tenantId>`,
 *     `SK = BOOKING#<id>`) using an atomic create, and return the `booked`
 *     outcome (R14.1, R14.2 / Property 3).
 */
export async function createBooking(
  request: BookingRequest,
  deps: CreateBookingDeps,
): Promise<BookingOutcome> {
  const { tenantId, slot } = request;

  // The orchestrator propagates a Validated_Session tenant into every state
  // input; defend against a missing one rather than silently mis-scoping.
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new BookingValidationError(
      'Booking request is missing a tenantId (it must be propagated from the orchestrator).',
    );
  }
  if (typeof slot !== 'string' || slot.length === 0) {
    throw new BookingValidationError('Booking request is missing a slot.');
  }

  // R14.3 / Property 17 — unavailable slot: create nothing.
  const available = await deps.availability.isAvailable(tenantId, slot);
  if (!available) {
    return { status: 'unavailable', tenantId, slot };
  }

  const bookingId =
    request.bookingId && request.bookingId.length > 0
      ? request.bookingId
      : (deps.newBookingId ?? defaultBookingId)();

  // R14.1 + R14.2 / Property 3 — persist a tenant-partitioned Booking item
  // through the shared wrapper. `createOnly` makes it an atomic create so a
  // duplicate booking id never silently overwrites an existing booking.
  const booking = await deps.persistence.put({
    tenantId,
    entityType: BOOKING_ENTITY_TYPE,
    sk: bookingSortKey(bookingId),
    data: {
      bookingId,
      slot,
      status: 'booked',
      ...(request.details ?? {}),
    },
    createOnly: true,
  });

  return { status: 'booked', booking };
}

/** Default booking-id generator (Node's built-in UUID; no extra dependency). */
function defaultBookingId(): string {
  // Lazy require keeps this module import-light and test-friendly.
  // `crypto.randomUUID` is available in the Node 20 Lambda runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('crypto') as typeof import('crypto');
  return randomUUID();
}
