/**
 * Unit tests for the WF-3 Orders handler's pure adaptation helpers (task 16.1).
 *
 * The `handler` entrypoint itself constructs an AWS SDK DynamoDB client at
 * invocation time (runtime-provided), so it is exercised by integration; here
 * we test the cloud-free seams it relies on.
 */

import { ORDER_TABLE_ENV, itemsFromPayload } from './handler';

describe('itemsFromPayload', () => {
  it('returns the payload items when present', () => {
    const items = [{ sku: 'A', quantity: 1 }];
    expect(itemsFromPayload({ items })).toEqual(items);
  });

  it('returns an empty array when items are missing', () => {
    expect(itemsFromPayload({})).toEqual([]);
  });

  it('returns an empty array when items are not an array', () => {
    expect(itemsFromPayload({ items: 'nope' })).toEqual([]);
  });
});

describe('ORDER_TABLE_ENV', () => {
  it('names the DM-2 table environment variable', () => {
    expect(ORDER_TABLE_ENV).toBe('DM2_TABLE_NAME');
  });
});
