import {
  StreamIngest,
  TENANT_TAG_KEY,
  buildIngestRecord,
  partitionKeyFor,
  partitionKeyIncludesTenant,
  tagCallTurn,
} from './stream_ingest';
import { TenantTagError } from '../../data/tagging';
import { InvalidTenantIdError } from '../../data/crypto/tenant_key';

const TURN = {
  callId: 'call-1',
  turn: 0,
  role: 'caller' as const,
  text: 'hi there',
};

describe('stream_ingest — tagCallTurn (Property 22 / Req 21.2)', () => {
  it('tags an ingested call turn with its owning tenant', () => {
    const rec = tagCallTurn('acme', TURN);
    expect(rec[TENANT_TAG_KEY]).toBe('acme');
    expect(rec.callId).toBe('call-1');
    expect(rec.role).toBe('caller');
    expect(rec.text).toBe('hi there');
  });

  it('defaults a timestamp when one is not supplied', () => {
    const rec = tagCallTurn('acme', TURN);
    expect(typeof rec.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(rec.timestamp as string))).toBe(false);
  });

  it('preserves a supplied timestamp', () => {
    const ts = '2024-01-01T00:00:00.000Z';
    const rec = tagCallTurn('acme', { ...TURN, timestamp: ts });
    expect(rec.timestamp).toBe(ts);
  });

  it('rejects a missing/invalid tenant', () => {
    expect(() => tagCallTurn('', TURN)).toThrow(TenantTagError);
    expect(() => tagCallTurn('a/b', TURN)).toThrow(TenantTagError);
  });

  it('rejects a turn without a callId', () => {
    expect(() => tagCallTurn('acme', { ...TURN, callId: '' })).toThrow(TenantTagError);
  });

  it('rejects a turn without a non-negative integer index', () => {
    expect(() => tagCallTurn('acme', { ...TURN, turn: -1 })).toThrow(TenantTagError);
    expect(() => tagCallTurn('acme', { ...TURN, turn: 1.5 })).toThrow(TenantTagError);
  });

  it('rejects an unknown role', () => {
    expect(() =>
      tagCallTurn('acme', { ...TURN, role: 'system' as unknown as 'caller' }),
    ).toThrow(TenantTagError);
  });

  it('rejects a turn already tagged for a different tenant', () => {
    const foreign = { ...TURN, [TENANT_TAG_KEY]: 'other' } as typeof TURN;
    expect(() => tagCallTurn('acme', foreign)).toThrow(TenantTagError);
  });
});

describe('stream_ingest — partition key includes the tenant (Req 21.2)', () => {
  it('leads the partition key with TENANT#<tenantId>', () => {
    expect(partitionKeyFor('acme', 'call-1')).toBe('TENANT#acme#CALL#call-1');
    expect(partitionKeyFor('acme')).toBe('TENANT#acme');
  });

  it('keys all turns of one call to the same partition key', () => {
    const k0 = partitionKeyFor('acme', 'call-1');
    const k1 = partitionKeyFor('acme', 'call-1');
    expect(k0).toBe(k1);
  });

  it('separates tenants with the same call id onto different keys', () => {
    expect(partitionKeyFor('acme', 'call-1')).not.toBe(partitionKeyFor('beta', 'call-1'));
  });

  it('recognises a tenant-scoped partition key', () => {
    expect(partitionKeyIncludesTenant('TENANT#acme#CALL#call-1', 'acme')).toBe(true);
    expect(partitionKeyIncludesTenant('TENANT#acme', 'acme')).toBe(true);
    expect(partitionKeyIncludesTenant('TENANT#beta#CALL#call-1', 'acme')).toBe(false);
    expect(partitionKeyIncludesTenant('acme', 'acme')).toBe(false);
  });

  it('rejects building a key for an invalid tenant', () => {
    expect(() => partitionKeyFor('a/b', 'call-1')).toThrow(InvalidTenantIdError);
  });
});

describe('stream_ingest — buildIngestRecord', () => {
  it('pairs a tagged payload with a tenant-scoped partition key', () => {
    const rec = buildIngestRecord('acme', TURN);
    expect(rec.partitionKey).toBe('TENANT#acme#CALL#call-1');
    expect(rec.data[TENANT_TAG_KEY]).toBe('acme');
    expect(partitionKeyIncludesTenant(rec.partitionKey, 'acme')).toBe(true);
  });
});

describe('stream_ingest — StreamIngest producer (Req 21.1)', () => {
  it('puts a tenant-tagged, tenant-keyed record on the stream', async () => {
    const putRecord = jest.fn(async () => ({}));
    const ingest = new StreamIngest({ putRecord });
    const rec = await ingest.ingestTurn('acme', TURN);

    expect(putRecord).toHaveBeenCalledTimes(1);
    const arg = (putRecord.mock.calls as any[])[0]?.[0] as {
      partitionKey: string;
      data: string;
    };
    expect(arg.partitionKey).toBe('TENANT#acme#CALL#call-1');
    const parsed = JSON.parse(arg.data);
    expect(parsed[TENANT_TAG_KEY]).toBe('acme');
    expect(parsed.callId).toBe('call-1');
    expect(rec.data[TENANT_TAG_KEY]).toBe('acme');
  });

  it('ingests a batch preserving input order', async () => {
    const putRecord = jest.fn(async () => ({}));
    const ingest = new StreamIngest({ putRecord });
    const turns = [
      { ...TURN, turn: 0 },
      { ...TURN, turn: 1, role: 'agent' as const, text: 'hello' },
    ];
    const recs = await ingest.ingestTurns('acme', turns);

    expect(recs).toHaveLength(2);
    expect(putRecord).toHaveBeenCalledTimes(2);
    expect(recs.every((r) => r.data[TENANT_TAG_KEY] === 'acme')).toBe(true);
    expect(recs.map((r) => r.data.turn)).toEqual([0, 1]);
  });

  it('never puts a record for an invalid tenant', async () => {
    const putRecord = jest.fn(async () => ({}));
    const ingest = new StreamIngest({ putRecord });
    await expect(ingest.ingestTurn('a/b', TURN)).rejects.toThrow(TenantTagError);
    expect(putRecord).not.toHaveBeenCalled();
  });
});
