/**
 * Unit tests for the WF-2 Booking handler's pure adaptation helpers (task 15.1).
 *
 * The `handler` entrypoint itself constructs an AWS SDK DynamoDB client at
 * invocation time (runtime-provided), so it is exercised by integration; here
 * we test the cloud-free seams it relies on.
 */

import { BOOKING_TABLE_ENV, payloadAvailabilityChecker } from './handler';

describe('payloadAvailabilityChecker', () => {
  it('treats a slot as available by default', () => {
    expect(payloadAvailabilityChecker({}).isAvailable('t', 's')).toBe(true);
  });

  it('treats a slot as available when slotAvailable is true', () => {
    expect(
      payloadAvailabilityChecker({ slotAvailable: true }).isAvailable('t', 's'),
    ).toBe(true);
  });

  it('treats a slot as unavailable only when slotAvailable is explicitly false', () => {
    expect(
      payloadAvailabilityChecker({ slotAvailable: false }).isAvailable('t', 's'),
    ).toBe(false);
  });
});

describe('BOOKING_TABLE_ENV', () => {
  it('names the DM-2 table environment variable', () => {
    expect(BOOKING_TABLE_ENV).toBe('DM2_TABLE_NAME');
  });
});
