/**
 * Unit / example tests for the WF-2 Booking Service domain logic (task 15.1).
 *
 * Covers Requirement 14:
 *  - 14.1 booking is created scoped to the action's tenantId
 *  - 14.2 booking is persisted with PK = TENANT#<tenantId> (entityType Booking,
 *         SK BOOKING#<id>) via the shared TenantPersistence wrapper
 *  - 14.3 an unavailable slot returns an "unavailable" outcome and persists
 *         nothing
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import {
  BOOKING_ENTITY_TYPE,
  BOOKING_SK_PREFIX,
  BookingValidationError,
  SlotAvailabilityChecker,
  bookingSortKey,
  createBooking,
} from './booking';

/** A writer that records every put so tests can assert on what was persisted. */
class RecordingWriter implements DynamoDocumentWriter {
  readonly puts: PutItemInput[] = [];
  async put(input: PutItemInput): Promise<unknown> {
    this.puts.push(input);
    return {};
  }
}

const available: SlotAvailabilityChecker = { isAvailable: () => true };
const unavailable: SlotAvailabilityChecker = { isAvailable: () => false };

function persistence(writer: DynamoDocumentWriter): TenantPersistence {
  return new TenantPersistence('dm2-table', writer);
}

describe('createBooking', () => {
  it('creates a tenant-partitioned Booking item for an available slot (R14.1, R14.2)', async () => {
    const writer = new RecordingWriter();
    const outcome = await createBooking(
      {
        tenantId: 'tenant-abc',
        slot: '2025-01-02T10:00:00Z',
        details: { service: 'HVAC tune-up', contact: { email: 'a@b.com' } },
      },
      {
        persistence: persistence(writer),
        availability: available,
        newBookingId: () => 'bk-123',
      },
    );

    expect(outcome.status).toBe('booked');
    expect(writer.puts).toHaveLength(1);

    const item = writer.puts[0].Item;
    // R14.2 / Property 3 — tenant partition key.
    expect(item.PK).toBe('TENANT#tenant-abc');
    expect(item.tenantId).toBe('tenant-abc');
    expect(item.entityType).toBe(BOOKING_ENTITY_TYPE);
    expect(item.SK).toBe(`${BOOKING_SK_PREFIX}bk-123`);
    // The booking payload is preserved.
    expect(item.data).toMatchObject({
      bookingId: 'bk-123',
      slot: '2025-01-02T10:00:00Z',
      status: 'booked',
      service: 'HVAC tune-up',
    });
    // Atomic create (no silent overwrite).
    expect(writer.puts[0].ConditionExpression).toContain('attribute_not_exists');

    if (outcome.status === 'booked') {
      expect(outcome.booking.SK).toBe(bookingSortKey('bk-123'));
    }
  });

  it('scopes the booking to the action tenant, not any client-supplied value (R14.1)', async () => {
    const writer = new RecordingWriter();
    await createBooking(
      {
        tenantId: 'tenant-real',
        slot: 's1',
        // A stray tenant in details must NOT influence the partition key.
        details: { tenantId: 'tenant-evil' },
      },
      { persistence: persistence(writer), availability: available, newBookingId: () => 'bk1' },
    );
    expect(writer.puts[0].Item.PK).toBe('TENANT#tenant-real');
    expect(writer.puts[0].Item.tenantId).toBe('tenant-real');
  });

  it('returns "unavailable" and persists nothing when the slot is unavailable (R14.3 / Property 17)', async () => {
    const writer = new RecordingWriter();
    const outcome = await createBooking(
      { tenantId: 'tenant-abc', slot: 'taken-slot' },
      { persistence: persistence(writer), availability: unavailable, newBookingId: () => 'bk1' },
    );

    expect(outcome).toEqual({
      status: 'unavailable',
      tenantId: 'tenant-abc',
      slot: 'taken-slot',
    });
    expect(writer.puts).toHaveLength(0);
  });

  it('honors a caller-supplied booking id when present', async () => {
    const writer = new RecordingWriter();
    await createBooking(
      { tenantId: 't1', slot: 's1', bookingId: 'explicit-id' },
      { persistence: persistence(writer), availability: available },
    );
    expect(writer.puts[0].Item.SK).toBe(`${BOOKING_SK_PREFIX}explicit-id`);
  });

  it('rejects a request with no slot as a validation error and persists nothing', async () => {
    const writer = new RecordingWriter();
    await expect(
      createBooking(
        { tenantId: 't1', slot: '' },
        { persistence: persistence(writer), availability: available },
      ),
    ).rejects.toBeInstanceOf(BookingValidationError);
    expect(writer.puts).toHaveLength(0);
  });

  it('rejects a request with no tenant as a validation error and persists nothing', async () => {
    const writer = new RecordingWriter();
    await expect(
      createBooking(
        { tenantId: '', slot: 's1' },
        { persistence: persistence(writer), availability: available },
      ),
    ).rejects.toBeInstanceOf(BookingValidationError);
    expect(writer.puts).toHaveLength(0);
  });

  it('does not check availability after a structural rejection (no write attempted)', async () => {
    const writer = new RecordingWriter();
    let checked = false;
    const spyChecker: SlotAvailabilityChecker = {
      isAvailable: () => {
        checked = true;
        return true;
      },
    };
    await expect(
      createBooking(
        { tenantId: 't1', slot: '' },
        { persistence: persistence(writer), availability: spyChecker },
      ),
    ).rejects.toBeInstanceOf(BookingValidationError);
    expect(checked).toBe(false);
  });
});

describe('bookingSortKey', () => {
  it('builds BOOKING#<id>', () => {
    expect(bookingSortKey('abc')).toBe('BOOKING#abc');
  });
  it('rejects an empty id', () => {
    expect(() => bookingSortKey('')).toThrow();
  });
});
