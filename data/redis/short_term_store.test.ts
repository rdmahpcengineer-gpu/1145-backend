import * as fc from 'fast-check';
import {
  CALL_NAMESPACE,
  KEY_SEPARATOR,
  RedisScopeError,
  TENANT_NAMESPACE,
  assertWithinTenant,
  callPrefix,
  isValidId,
  isWithinTenant,
  shortTermKey,
  tenantPrefix,
} from './keys';
import {
  DEFAULT_CALL_TTL_SECONDS,
  RedisClient,
  ShortTermStore,
} from './short_term_store';

/**
 * An in-memory fake Redis honouring the narrow {@link RedisClient} contract,
 * including TTL bookkeeping and prefix scans. Lets the store be tested against
 * real behaviour (no mocks of the unit under test).
 */
class FakeRedis implements RedisClient {
  readonly store = new Map<string, { value: string; ttl: number }>();
  readonly sets: Array<{ key: string; value: string; ttl: number }> = [];

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, ttl: ttlSeconds });
    this.sets.push({ key, value, ttl: ttlSeconds });
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async del(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async scanPrefix(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

describe('redis/keys — id validation', () => {
  it('accepts well-formed ids', () => {
    expect(isValidId('acme')).toBe(true);
    expect(isValidId('call-123_AB')).toBe(true);
  });

  it('rejects empty, non-string, and unsafe ids', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId('a:b')).toBe(false); // would inject a key segment
    expect(isValidId('a/b')).toBe(false);
    expect(isValidId('-leading')).toBe(false);
  });
});

describe('redis/keys — key construction (t:<tenantId>:call:<callId>:...)', () => {
  it('builds the tenant prefix', () => {
    expect(tenantPrefix('acme')).toBe(
      `${TENANT_NAMESPACE}${KEY_SEPARATOR}acme${KEY_SEPARATOR}`,
    );
    expect(tenantPrefix('acme')).toBe('t:acme:');
  });

  it('builds the call prefix', () => {
    expect(callPrefix('acme', 'c1')).toBe(
      `t:acme:${CALL_NAMESPACE}:c1:`,
    );
    expect(callPrefix('acme', 'c1')).toBe('t:acme:call:c1:');
  });

  it('builds a fully-qualified short-term key with field segments', () => {
    expect(shortTermKey('acme', 'c1', 'transcript')).toBe(
      't:acme:call:c1:transcript',
    );
    expect(shortTermKey('acme', 'c1', 'turn', '5')).toBe(
      't:acme:call:c1:turn:5',
    );
  });

  it('rejects key construction without a valid tenant/call scope', () => {
    expect(() => shortTermKey('', 'c1', 'f')).toThrow(RedisScopeError);
    expect(() => shortTermKey('acme', '', 'f')).toThrow(RedisScopeError);
    expect(() => shortTermKey('a:b', 'c1', 'f')).toThrow(RedisScopeError);
  });

  it('requires at least one field segment and rejects separator-bearing segments', () => {
    expect(() => shortTermKey('acme', 'c1')).toThrow(RedisScopeError);
    expect(() => shortTermKey('acme', 'c1', 'a:b')).toThrow(RedisScopeError);
    expect(() => shortTermKey('acme', 'c1', '')).toThrow(RedisScopeError);
  });
});

describe('redis/keys — tenant confinement guard', () => {
  it('accepts keys within the tenant namespace', () => {
    expect(isWithinTenant('acme', 't:acme:call:c1:f')).toBe(true);
    expect(() => assertWithinTenant('acme', 't:acme:call:c1:f')).not.toThrow();
  });

  it('rejects keys belonging to another tenant', () => {
    expect(isWithinTenant('acme', 't:other:call:c1:f')).toBe(false);
    expect(() => assertWithinTenant('acme', 't:other:call:c1:f')).toThrow(
      RedisScopeError,
    );
    // A tenant prefix that is a string-prefix of another must not leak.
    expect(isWithinTenant('acme', 't:acme-evil:call:c1:f')).toBe(false);
  });
});

describe('ShortTermStore — writes carry a call-lifetime TTL', () => {
  it('applies the default call-lifetime TTL', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis);
    const key = await store.put('acme', 'c1', ['transcript'], 'hi');
    expect(key).toBe('t:acme:call:c1:transcript');
    expect(redis.sets[0]).toEqual({
      key: 't:acme:call:c1:transcript',
      value: 'hi',
      ttl: DEFAULT_CALL_TTL_SECONDS,
    });
  });

  it('honours a per-write TTL and a store-wide default override', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis, { defaultTtlSeconds: 120 });
    await store.put('acme', 'c1', ['a'], 'x');
    await store.put('acme', 'c1', ['b'], 'y', 30);
    expect(redis.sets[0].ttl).toBe(120);
    expect(redis.sets[1].ttl).toBe(30);
  });

  it('rejects a non-positive TTL', () => {
    const redis = new FakeRedis();
    expect(() => new ShortTermStore(redis, { defaultTtlSeconds: 0 })).toThrow(
      RedisScopeError,
    );
  });
});

describe('ShortTermStore — reads are confined to the tenant prefix', () => {
  it('reads back only this tenant/call entry', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis);
    await store.put('acme', 'c1', ['transcript'], 'hello');
    expect(await store.get('acme', 'c1', ['transcript'])).toBe('hello');
    expect(await store.get('acme', 'c1', ['missing'])).toBeNull();
  });

  it('listCall returns only the call’s entries, never another tenant’s', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis);
    await store.put('acme', 'c1', ['turn', '1'], 'a');
    await store.put('acme', 'c1', ['turn', '2'], 'b');
    await store.put('acme', 'c2', ['turn', '1'], 'other-call');
    await store.put('evil', 'c1', ['turn', '1'], 'foreign');

    const entries = await store.listCall('acme', 'c1');
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(['t:acme:call:c1:turn:1', 't:acme:call:c1:turn:2']);
    expect(entries.every((e) => e.key.startsWith('t:acme:'))).toBe(true);
  });

  it('listTenantKeys is confined to the tenant namespace', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis);
    await store.put('acme', 'c1', ['x'], '1');
    await store.put('acme', 'c2', ['y'], '2');
    await store.put('evil', 'c1', ['z'], '3');
    const keys = (await store.listTenantKeys('acme')).sort();
    expect(keys).toEqual(['t:acme:call:c1:x', 't:acme:call:c2:y']);
  });

  it('rejects a foreign key surfaced by the client (defense in depth)', async () => {
    // A buggy/compromised scan returns a foreign key under a tenant prefix
    // string-match; the guard must still reject it.
    const redis = new FakeRedis();
    redis.store.set('t:acme-evil:call:c1:x', { value: 'leak', ttl: 60 });
    const leakyClient: RedisClient = {
      ...redis,
      set: redis.set.bind(redis),
      get: redis.get.bind(redis),
      del: redis.del.bind(redis),
      scanPrefix: async () => ['t:acme-evil:call:c1:x'],
    };
    const store = new ShortTermStore(leakyClient);
    await expect(store.listTenantKeys('acme')).rejects.toThrow(RedisScopeError);
  });
});

describe('ShortTermStore — clearCall', () => {
  it('removes only the target call’s entries and returns the count', async () => {
    const redis = new FakeRedis();
    const store = new ShortTermStore(redis);
    await store.put('acme', 'c1', ['a'], '1');
    await store.put('acme', 'c1', ['b'], '2');
    await store.put('acme', 'c2', ['a'], 'keep');

    const removed = await store.clearCall('acme', 'c1');
    expect(removed).toBe(2);
    expect(await store.get('acme', 'c1', ['a'])).toBeNull();
    expect(await store.get('acme', 'c2', ['a'])).toBe('keep');
  });

  it('returns 0 when there is nothing to clear', async () => {
    const store = new ShortTermStore(new FakeRedis());
    expect(await store.clearCall('acme', 'absent')).toBe(0);
  });
});

describe('ShortTermStore — property: reads never cross the tenant boundary', () => {
  it('a read in tenant T only ever returns keys under t:<T>:', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Two distinct tenants and a set of calls/fields.
        fc
          .tuple(
            fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/),
            fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/),
          )
          .filter(([a, b]) => a !== b),
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,8}$/),
            fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,8}$/),
            fc.string(),
          ),
          { maxLength: 20 },
        ),
        async ([tenantA, tenantB], rows) => {
          const redis = new FakeRedis();
          const store = new ShortTermStore(redis);
          // Seed identical call/field data under BOTH tenants.
          for (const [callId, field, value] of rows) {
            await store.put(tenantA, callId, [field], value);
            await store.put(tenantB, callId, [field], value);
          }
          const prefixA = tenantPrefix(tenantA);
          const keysA = await store.listTenantKeys(tenantA);
          // Every key read in A's context is within A's namespace, and none
          // belongs to B.
          expect(keysA.every((k) => k.startsWith(prefixA))).toBe(true);
          expect(keysA.some((k) => k.startsWith(tenantPrefix(tenantB)))).toBe(
            false,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
