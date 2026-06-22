import {
  DynamoDocumentWriter,
  PersistedItem,
  PutItemInput,
  TenantPersistence,
  assertTenantScoped,
} from './tenant-persistence';
import { TenantScopeError } from './errors';
import { TENANT_PK_PREFIX, tenantPartitionKey } from './keys';
import { encryptionContextForTenant } from '../crypto/tenant_key';

/** A spy writer that records every put it receives instead of hitting AWS. */
class RecordingWriter implements DynamoDocumentWriter {
  readonly puts: PutItemInput[] = [];
  async put(input: PutItemInput): Promise<unknown> {
    this.puts.push(input);
    return {};
  }
}

const TABLE = 'DataTable-test';
const FIXED_NOW = new Date('2024-01-02T03:04:05.000Z');

function newPersistence(writer: DynamoDocumentWriter): TenantPersistence {
  return new TenantPersistence(TABLE, writer, () => FIXED_NOW);
}

describe('TenantPersistence.buildItem', () => {
  it('stamps PK, tenantId, entityType, and createdAt on a write', () => {
    const writer = new RecordingWriter();
    const item = newPersistence(writer).buildItem({
      tenantId: 'acme',
      entityType: 'Booking',
      sk: 'BOOKING#123',
      data: { slot: '2024-02-01T10:00' },
    });

    expect(item).toEqual<PersistedItem>({
      PK: 'TENANT#acme',
      SK: 'BOOKING#123',
      entityType: 'Booking',
      tenantId: 'acme',
      data: { slot: '2024-02-01T10:00' },
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it('always prefixes the partition key with TENANT#', () => {
    const item = newPersistence(new RecordingWriter()).buildItem({
      tenantId: 'tenant-9',
      entityType: 'Order',
      sk: 'ORDER#1',
      data: {},
    });
    expect(item.PK.startsWith(TENANT_PK_PREFIX)).toBe(true);
    expect(item.PK).toBe(tenantPartitionKey('tenant-9'));
  });

  it('honors an explicit createdAt override', () => {
    const item = newPersistence(new RecordingWriter()).buildItem({
      tenantId: 'acme',
      entityType: 'Lead',
      sk: 'LEAD#7',
      data: {},
      createdAt: '2020-05-05T00:00:00.000Z',
    });
    expect(item.createdAt).toBe('2020-05-05T00:00:00.000Z');
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
  ])('rejects a write with a missing tenantId (%s)', (_label, tenantId) => {
    const p = newPersistence(new RecordingWriter());
    expect(() =>
      p.buildItem({
        // @ts-expect-error exercising invalid runtime input
        tenantId,
        entityType: 'Call',
        sk: 'CALL#1',
        data: {},
      }),
    ).toThrow(TenantScopeError);
  });

  it.each([
    ['slash injection', 'acme/evil'],
    ['leading dash', '-bad'],
    ['too long', 'x'.repeat(200)],
  ])('rejects a write with an invalid tenantId (%s)', (_label, tenantId) => {
    const p = newPersistence(new RecordingWriter());
    let caught: unknown;
    try {
      p.buildItem({ tenantId, entityType: 'Call', sk: 'CALL#1', data: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TenantScopeError);
    expect((caught as TenantScopeError).violation).toBe('invalid-tenant-id');
  });

  it('rejects a write with a missing sort key', () => {
    const p = newPersistence(new RecordingWriter());
    expect(() =>
      p.buildItem({ tenantId: 'acme', entityType: 'Call', sk: '', data: {} }),
    ).toThrow(TenantScopeError);
  });
});

describe('TenantPersistence.put', () => {
  it('writes a fully-formed, tenant-partitioned item to the table', async () => {
    const writer = new RecordingWriter();
    await newPersistence(writer).put({
      tenantId: 'acme',
      entityType: 'Order',
      sk: 'ORDER#42',
      data: { total: 100 },
    });

    expect(writer.puts).toHaveLength(1);
    const input = writer.puts[0];
    expect(input.TableName).toBe(TABLE);
    expect(input.Item.PK).toBe('TENANT#acme');
    expect(input.Item.tenantId).toBe('acme');
    expect(input.Item.entityType).toBe('Order');
  });

  it('attaches the tenant KMS encryption context to every put', async () => {
    const writer = new RecordingWriter();
    await newPersistence(writer).put({
      tenantId: 'acme',
      entityType: 'Order',
      sk: 'ORDER#42',
      data: {},
    });
    expect(writer.puts[0].encryptionContext).toEqual(
      encryptionContextForTenant('acme'),
    );
  });

  it('adds a create-only condition expression when requested', async () => {
    const writer = new RecordingWriter();
    await newPersistence(writer).put({
      tenantId: 'acme',
      entityType: 'Booking',
      sk: 'BOOKING#1',
      data: {},
      createOnly: true,
    });
    const input = writer.puts[0];
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#sk': 'SK' });
  });

  it('never calls the writer when the tenant scope is missing', async () => {
    const writer = new RecordingWriter();
    const p = newPersistence(writer);
    await expect(
      p.put({
        // @ts-expect-error exercising invalid runtime input
        tenantId: undefined,
        entityType: 'Call',
        sk: 'CALL#1',
        data: {},
      }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(writer.puts).toHaveLength(0);
  });
});

describe('TenantPersistence.putItem (pre-built items)', () => {
  it('persists a well-formed pre-built item', async () => {
    const writer = new RecordingWriter();
    const item: PersistedItem = {
      PK: 'TENANT#acme',
      SK: 'CALL#1',
      entityType: 'Call',
      tenantId: 'acme',
      data: {},
      createdAt: FIXED_NOW.toISOString(),
    };
    await newPersistence(writer).putItem(item);
    expect(writer.puts[0].Item).toBe(item);
  });

  it('rejects a pre-built item whose PK tenant disagrees with its tenantId', async () => {
    const writer = new RecordingWriter();
    const item = {
      PK: 'TENANT#acme',
      SK: 'CALL#1',
      entityType: 'Call' as const,
      tenantId: 'other',
      data: {},
      createdAt: FIXED_NOW.toISOString(),
    };
    await expect(newPersistence(writer).putItem(item)).rejects.toMatchObject({
      violation: 'tenant-mismatch',
    });
    expect(writer.puts).toHaveLength(0);
  });
});

describe('assertTenantScoped', () => {
  it('accepts a consistent tenant-partitioned item', () => {
    expect(() =>
      assertTenantScoped({
        PK: 'TENANT#acme',
        SK: 'ORDER#1',
        entityType: 'Order',
        tenantId: 'acme',
        data: {},
        createdAt: FIXED_NOW.toISOString(),
      }),
    ).not.toThrow();
  });

  it.each([
    ['null item', null, 'missing-partition-key'],
    [
      'missing PK',
      { SK: 'X', entityType: 'Order', tenantId: 'a', data: {}, createdAt: 'x' },
      'missing-partition-key',
    ],
    [
      'non-tenant PK',
      {
        PK: 'GLOBAL#1',
        SK: 'X',
        entityType: 'Order',
        tenantId: 'a',
        data: {},
        createdAt: 'x',
      },
      'malformed-partition-key',
    ],
    [
      'missing tenantId scalar',
      { PK: 'TENANT#a', SK: 'X', entityType: 'Order', data: {}, createdAt: 'x' },
      'missing-tenant-id',
    ],
  ])('rejects %s', (_label, bad, violation) => {
    let caught: unknown;
    try {
      // @ts-expect-error exercising invalid runtime input
      assertTenantScoped(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TenantScopeError);
    expect((caught as TenantScopeError).violation).toBe(violation);
  });
});
