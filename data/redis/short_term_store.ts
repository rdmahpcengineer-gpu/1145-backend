/**
 * data/redis/short_term_store — the DM-1 short-term store access module.
 *
 * Every short-term (within-call) memory access in the backend MUST go through
 * this module. It is the single choke point that enforces the DM-1 invariants
 * (design.md "DM-1 Redis — short-term store"; Requirement 17):
 *
 *   1. Entries are keyed `t:<tenantId>:call:<callId>:...` (Req 17.2), built only
 *      via `data/redis/keys` so the tenant/call namespace can never drift.
 *   2. Every write carries a call-lifetime TTL (Req 17.1) so per-call memory
 *      expires automatically when the call is over.
 *   3. Reads are confined to the requesting tenant's key prefix (Req 17.3):
 *      list/scan operations target `t:<tenantId>:...` and every resolved key is
 *      re-checked with {@link assertWithinTenant} before it is read, so a read
 *      in tenant `T`'s context can never return another tenant's entry.
 *
 * The module depends on a narrow {@link RedisClient} interface rather than a
 * concrete Redis driver, so it is trivially unit-testable and free of network
 * coupling. At runtime a thin adapter over the chosen Redis client (addressed
 * via the endpoint published in shared/wiring) is injected.
 *
 * _Requirements: 17.1, 17.2, 17.3_
 */

import {
  RedisScopeError,
  assertWithinTenant,
  callPrefix,
  shortTermKey,
  tenantPrefix,
} from './keys';

/**
 * Default call-lifetime TTL (seconds) applied to every short-term entry. Sized
 * generously above a typical call so within-call memory survives the whole call
 * but is reclaimed automatically afterwards. Override per-write or per-store.
 */
export const DEFAULT_CALL_TTL_SECONDS = 3600; // 1 hour

/**
 * Minimal Redis surface the store needs (decoupled from any concrete driver).
 *
 * `scanPrefix` MUST return only keys that begin with the supplied prefix; the
 * store additionally re-validates every returned key against the tenant
 * namespace as defense in depth.
 */
export interface RedisClient {
  /** Set `key` to `value` with an expiry of `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Get `key`, or `null` if absent/expired. */
  get(key: string): Promise<string | null>;
  /** Delete the given keys; returns the number removed. */
  del(keys: string[]): Promise<number>;
  /** Return every key beginning with `prefix`. */
  scanPrefix(prefix: string): Promise<string[]>;
}

/** Options controlling store-wide behaviour. */
export interface ShortTermStoreOptions {
  /** Call-lifetime TTL (seconds) for writes that do not specify their own. */
  readonly defaultTtlSeconds?: number;
}

/** A short-term entry resolved within a tenant's namespace. */
export interface ShortTermEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Tenant- and call-scoped access to the DM-1 Redis short-term store.
 *
 * All keys are constructed from the operative `tenantId` (which MUST come from
 * a Validated_Session, never a client field) so cross-tenant access is
 * structurally impossible.
 */
export class ShortTermStore {
  private readonly defaultTtlSeconds: number;

  constructor(
    private readonly client: RedisClient,
    options: ShortTermStoreOptions = {},
  ) {
    const ttl = options.defaultTtlSeconds ?? DEFAULT_CALL_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RedisScopeError(
        `Short-term store TTL must be a positive number of seconds, got ${ttl}.`,
      );
    }
    this.defaultTtlSeconds = ttl;
  }

  /**
   * Write a short-term entry for `tenantId`/`callId` under the field
   * `segments`, with a call-lifetime TTL. Throws {@link RedisScopeError} if the
   * tenant/call scope is missing or malformed — before any Redis command runs.
   */
  async put(
    tenantId: string,
    callId: string,
    segments: string[],
    value: string,
    ttlSeconds?: number,
  ): Promise<string> {
    const key = shortTermKey(tenantId, callId, ...segments);
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RedisScopeError(
        `A call-lifetime TTL must be a positive number of seconds, got ${ttl}.`,
      );
    }
    await this.client.set(key, value, ttl);
    return key;
  }

  /**
   * Read a single short-term entry for `tenantId`/`callId`. The key is built
   * within the tenant namespace and re-checked, so a read can never escape the
   * tenant's prefix. Returns `null` when the entry is absent/expired.
   */
  async get(
    tenantId: string,
    callId: string,
    segments: string[],
  ): Promise<string | null> {
    const key = shortTermKey(tenantId, callId, ...segments);
    // Defense in depth: the key we built must lie within the tenant namespace.
    assertWithinTenant(tenantId, key);
    return this.client.get(key);
  }

  /**
   * List every short-term entry for a single call, confined to
   * `t:<tenantId>:call:<callId>:`. Any key the client returns that is somehow
   * outside the tenant namespace is rejected rather than read.
   */
  async listCall(tenantId: string, callId: string): Promise<ShortTermEntry[]> {
    const prefix = callPrefix(tenantId, callId);
    const keys = await this.client.scanPrefix(prefix);
    const entries: ShortTermEntry[] = [];
    for (const key of keys) {
      // Confine reads to this tenant's namespace (Req 17.3).
      assertWithinTenant(tenantId, key);
      const value = await this.client.get(key);
      if (value !== null) entries.push({ key, value });
    }
    return entries;
  }

  /**
   * List the keys of every short-term entry owned by a tenant, confined to
   * `t:<tenantId>:`. Useful for tenant-scoped maintenance; never crosses into
   * another tenant's namespace.
   */
  async listTenantKeys(tenantId: string): Promise<string[]> {
    const prefix = tenantPrefix(tenantId);
    const keys = await this.client.scanPrefix(prefix);
    keys.forEach((key) => assertWithinTenant(tenantId, key));
    return keys;
  }

  /**
   * Explicitly clear all short-term memory for a call (e.g. on `CallEnd`,
   * complementing the TTL). Confined to the call's prefix within the tenant
   * namespace. Returns the number of entries removed.
   */
  async clearCall(tenantId: string, callId: string): Promise<number> {
    const prefix = callPrefix(tenantId, callId);
    const keys = await this.client.scanPrefix(prefix);
    if (keys.length === 0) return 0;
    keys.forEach((key) => assertWithinTenant(tenantId, key));
    return this.client.del(keys);
  }
}
