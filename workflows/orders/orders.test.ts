/**
 * Unit / example tests for the WF-3 Orders Service domain logic (task 16.1).
 *
 * Covers Requirement 15:
 *  - 15.1 order is created scoped to the action's tenantId
 *  - 15.2 order is persisted with PK = TENANT#<tenantId> (entityType Order,
 *         SK ORDER#<id>) via the shared TenantPersistence wrapper
 *  - 15.3 an invalid order is rejected with a validation error and persists
 *         no partial order (single conditional write)
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import {
  ORDER_ENTITY_TYPE,
  ORDER_SK_PREFIX,
  OrderValidationError,
  createOrder,
  orderSortKey,
  validateOrderRequest,
} from './orders';

/** A writer that records every put so tests can assert on what was persisted. */
class RecordingWriter implements DynamoDocumentWriter {
  readonly puts: PutItemInput[] = [];
  async put(input: PutItemInput): Promise<unknown> {
    this.puts.push(input);
    return {};
  }
}

function persistence(writer: DynamoDocumentWriter): TenantPersistence {
  return new TenantPersistence('dm2-table', writer);
}

describe('createOrder', () => {
  it('creates a tenant-partitioned Order item for a valid request (R15.1, R15.2)', async () => {
    const writer = new RecordingWriter();
    const outcome = await createOrder(
      {
        tenantId: 'tenant-abc',
        items: [{ sku: 'WIDGET-1', quantity: 2 }],
        details: { contact: { email: 'a@b.com' }, notes: 'leave at door' },
      },
      { persistence: persistence(writer), newOrderId: () => 'ord-123' },
    );

    expect(outcome.status).toBe('placed');
    expect(writer.puts).toHaveLength(1);

    const item = writer.puts[0].Item;
    // R15.2 / Property 3 — tenant partition key.
    expect(item.PK).toBe('TENANT#tenant-abc');
    expect(item.tenantId).toBe('tenant-abc');
    expect(item.entityType).toBe(ORDER_ENTITY_TYPE);
    expect(item.SK).toBe(`${ORDER_SK_PREFIX}ord-123`);
    // The order payload is preserved.
    expect(item.data).toMatchObject({
      orderId: 'ord-123',
      status: 'placed',
      notes: 'leave at door',
    });
    expect(item.data.items).toEqual([{ sku: 'WIDGET-1', quantity: 2 }]);
    // Single conditional create (no silent overwrite).
    expect(writer.puts[0].ConditionExpression).toContain('attribute_not_exists');

    if (outcome.status === 'placed') {
      expect(outcome.order.SK).toBe(orderSortKey('ord-123'));
    }
  });

  it('scopes the order to the action tenant, not any client-supplied value (R15.1)', async () => {
    const writer = new RecordingWriter();
    await createOrder(
      {
        tenantId: 'tenant-real',
        items: [{ sku: 'A', quantity: 1 }],
        // A stray tenant in details must NOT influence the partition key.
        details: { tenantId: 'tenant-evil' },
      },
      { persistence: persistence(writer), newOrderId: () => 'o1' },
    );
    expect(writer.puts[0].Item.PK).toBe('TENANT#tenant-real');
    expect(writer.puts[0].Item.tenantId).toBe('tenant-real');
  });

  it('honors a caller-supplied order id when present', async () => {
    const writer = new RecordingWriter();
    await createOrder(
      { tenantId: 't1', items: [{ sku: 'A', quantity: 1 }], orderId: 'explicit-id' },
      { persistence: persistence(writer) },
    );
    expect(writer.puts[0].Item.SK).toBe(`${ORDER_SK_PREFIX}explicit-id`);
  });

  it('rejects an order with no items and persists nothing (R15.3 / Property 18)', async () => {
    const writer = new RecordingWriter();
    await expect(
      createOrder(
        { tenantId: 't1', items: [] },
        { persistence: persistence(writer) },
      ),
    ).rejects.toBeInstanceOf(OrderValidationError);
    expect(writer.puts).toHaveLength(0);
  });

  it('rejects an order with a non-positive quantity and persists nothing (R15.3 / Property 18)', async () => {
    const writer = new RecordingWriter();
    await expect(
      createOrder(
        { tenantId: 't1', items: [{ sku: 'A', quantity: 0 }] },
        { persistence: persistence(writer) },
      ),
    ).rejects.toBeInstanceOf(OrderValidationError);
    expect(writer.puts).toHaveLength(0);
  });

  it('rejects an order with a missing sku and persists nothing (R15.3 / Property 18)', async () => {
    const writer = new RecordingWriter();
    await expect(
      createOrder(
        { tenantId: 't1', items: [{ sku: '', quantity: 1 }] },
        { persistence: persistence(writer) },
      ),
    ).rejects.toBeInstanceOf(OrderValidationError);
    expect(writer.puts).toHaveLength(0);
  });

  it('rejects an order with no tenant as a validation error and persists nothing', async () => {
    const writer = new RecordingWriter();
    await expect(
      createOrder(
        { tenantId: '', items: [{ sku: 'A', quantity: 1 }] },
        { persistence: persistence(writer) },
      ),
    ).rejects.toBeInstanceOf(OrderValidationError);
    expect(writer.puts).toHaveLength(0);
  });
});

describe('validateOrderRequest', () => {
  it('returns the line items for a valid request', () => {
    const items = [{ sku: 'A', quantity: 3 }];
    expect(validateOrderRequest({ tenantId: 't1', items })).toEqual(items);
  });

  it('rejects a fractional quantity', () => {
    expect(() =>
      validateOrderRequest({ tenantId: 't1', items: [{ sku: 'A', quantity: 1.5 }] }),
    ).toThrow(OrderValidationError);
  });
});

describe('orderSortKey', () => {
  it('builds ORDER#<id>', () => {
    expect(orderSortKey('abc')).toBe('ORDER#abc');
  });
  it('rejects an empty id', () => {
    expect(() => orderSortKey('')).toThrow();
  });
});
