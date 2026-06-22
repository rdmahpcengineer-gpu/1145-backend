/**
 * ml/ingest/stream_ingest — ML-1 call-turn ingest (producer-side) logic.
 *
 * The producer-side logic for the ML-1 stream ingest (design.md "ML → ML-1"):
 *
 *   Kinesis stream ingesting call-turn data; EVERY record is tagged with
 *   `tenantId` and the partition key includes the tenant.
 *
 * Like the DM-3 embedding store, this module is deliberately independent of the
 * AWS SDK: it models exactly the two ML-1 rules and lets the construct provision
 * the concrete Kinesis stream. It reuses the SAME shared tenant-tagging helper
 * (`data/tagging`) that the DM-3 embedding store uses, so the cross-cutting
 * tagging invariant (design Property 22) is enforced by one choke point:
 *
 *   1. TAG    — every ingested call-turn record is tenant-tagged via the shared
 *      `tagWithTenant` helper before it can be put on the stream. A
 *      missing/invalid tenant, or a record already tagged for a different
 *      tenant, is rejected with a {@link TenantTagError} before anything is
 *      produced (Requirement 21.2).
 *   2. KEY    — the Kinesis partition key is built so it INCLUDES the tenant
 *      (`TENANT#<tenantId>#CALL#<callId>`), so a tenant's turns never share a
 *      partition key with another tenant's, and all turns of one call land on
 *      the same shard (preserving per-call ordering).
 *
 * _Requirements: 21.1, 21.2_
 */

import {
  TENANT_TAG_KEY,
  TenantTagError,
  TenantTagged,
  assertTenantTagged,
  tagWithTenant,
} from '../../data/tagging';
import { assertValidTenantId, isValidTenantId } from '../../data/crypto/tenant_key';

/**
 * A single call-turn produced by the AC runtime, before tagging. This is the
 * "call-turn data" ML-1 ingests; `tenantId` is NOT part of the input — it is
 * stamped authoritatively from the validated session by {@link tagCallTurn}.
 */
export interface CallTurnInput {
  /** The call this turn belongs to. */
  readonly callId: string;
  /** Monotonic turn index within the call (0-based). */
  readonly turn: number;
  /** Who spoke this turn. */
  readonly role: 'caller' | 'agent';
  /** The utterance text for this turn. */
  readonly text: string;
  /** ISO-8601 timestamp the turn completed (defaults to now at build time). */
  readonly timestamp?: string;
}

/** A call-turn stamped with its owning tenant, ready to put on the stream. */
export type TaggedCallTurn = TenantTagged<CallTurnInput>;

/** Prefix segments that make a partition key tenant-scoped. */
const TENANT_KEY_PREFIX = 'TENANT#';
const CALL_KEY_SEGMENT = '#CALL#';

/**
 * Build the Kinesis partition key for a tenant's call. The key ALWAYS leads
 * with `TENANT#<tenantId>` so it includes the tenant (Requirement 21.2); the
 * call id is appended so every turn of one call hashes to the same shard,
 * preserving per-call ordering. A missing/invalid tenant is rejected before a
 * key can be produced.
 */
export function partitionKeyFor(tenantId: string, callId?: string): string {
  assertValidTenantId(tenantId);
  const base = `${TENANT_KEY_PREFIX}${tenantId}`;
  return callId ? `${base}${CALL_KEY_SEGMENT}${callId}` : base;
}

/** True iff `partitionKey` is scoped to (leads with) `tenantId`. */
export function partitionKeyIncludesTenant(
  partitionKey: string,
  tenantId: string,
): boolean {
  if (!isValidTenantId(tenantId) || typeof partitionKey !== 'string') return false;
  const base = `${TENANT_KEY_PREFIX}${tenantId}`;
  return partitionKey === base || partitionKey.startsWith(`${base}${CALL_KEY_SEGMENT}`);
}

/**
 * Tag a call-turn with its owning tenant. The returned record carries a
 * `tenantId` tag (design Property 22); a missing/invalid tenant, an
 * unusable turn, or a turn already tagged for a different tenant is rejected
 * with a {@link TenantTagError} before the record can be ingested.
 */
export function tagCallTurn(tenantId: string, turn: CallTurnInput): TaggedCallTurn {
  if (!turn || typeof turn !== 'object') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to ingest a null/undefined or non-object call turn.',
    );
  }
  if (typeof turn.callId !== 'string' || turn.callId.length === 0) {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to ingest a call turn without a callId.',
    );
  }
  if (typeof turn.turn !== 'number' || !Number.isInteger(turn.turn) || turn.turn < 0) {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to ingest a call turn without a non-negative integer turn index.',
    );
  }
  if (turn.role !== 'caller' && turn.role !== 'agent') {
    throw new TenantTagError(
      'missing-tag',
      `Refusing to ingest a call turn with an unknown role: ${JSON.stringify(turn.role)}.`,
    );
  }
  if (typeof turn.text !== 'string') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to ingest a call turn without text.',
    );
  }
  const normalized: CallTurnInput = {
    callId: turn.callId,
    turn: turn.turn,
    role: turn.role,
    text: turn.text,
    timestamp: turn.timestamp ?? new Date().toISOString(),
  };
  // Carry any pre-existing tenant tag through to the shared helper so a record
  // already homed to a DIFFERENT tenant is rejected (it can never be re-homed
  // by re-tagging) rather than silently dropped by normalization.
  const existingTag = (turn as unknown as Record<string, unknown>)[TENANT_TAG_KEY];
  const candidate =
    existingTag === undefined
      ? { ...normalized }
      : { ...normalized, [TENANT_TAG_KEY]: existingTag };
  return tagWithTenant(tenantId, candidate);
}

/** A tenant-tagged record paired with the tenant-scoped partition key. */
export interface IngestRecord {
  /** Partition key — always includes the tenant (Requirement 21.2). */
  readonly partitionKey: string;
  /** The tenant-tagged call-turn payload. */
  readonly data: TaggedCallTurn;
}

/**
 * Build a stream-ready ingest record from a call-turn: tag the payload with its
 * tenant and pair it with a tenant-scoped partition key. The single place that
 * couples "tag the record" to "key by the tenant" so neither can be skipped.
 */
export function buildIngestRecord(tenantId: string, turn: CallTurnInput): IngestRecord {
  const data = tagCallTurn(tenantId, turn);
  return {
    partitionKey: partitionKeyFor(tenantId, turn.callId),
    data,
  };
}

/**
 * The minimal put surface a runtime adapter implements over the concrete
 * Kinesis stream (AWS SDK `PutRecord`/`PutRecords`). Backend-neutral so the
 * ingest logic is exercised without the SDK.
 */
export interface KinesisPutClient {
  putRecord(input: { partitionKey: string; data: string }): Promise<unknown>;
}

/**
 * Thin producer that enforces the ML-1 invariants around any concrete Kinesis
 * client: every produced record is tenant-tagged first and keyed by a
 * tenant-scoped partition key. The AC runtime prefers this over calling the SDK
 * directly so an untagged or wrongly-keyed record can never reach the stream.
 */
export class StreamIngest {
  constructor(private readonly client: KinesisPutClient) {}

  /**
   * Ingest a single call-turn for `tenantId` (Requirement 21.1). The record is
   * tagged and keyed, re-asserted as tenant-tagged as a final gate, then put on
   * the stream as JSON.
   */
  async ingestTurn(tenantId: string, turn: CallTurnInput): Promise<IngestRecord> {
    const record = buildIngestRecord(tenantId, turn);
    // Final gate before the record reaches the stream: it MUST carry the tag,
    // and the tag MUST match the producing tenant.
    assertTenantTagged(record.data as unknown as Record<string, unknown>, tenantId);
    await this.client.putRecord({
      partitionKey: record.partitionKey,
      data: JSON.stringify(record.data),
    });
    return record;
  }

  /** Ingest a batch of call-turns for `tenantId`, preserving input order. */
  async ingestTurns(tenantId: string, turns: readonly CallTurnInput[]): Promise<IngestRecord[]> {
    const out: IngestRecord[] = [];
    for (const turn of turns) {
      out.push(await this.ingestTurn(tenantId, turn));
    }
    return out;
  }
}

/** Re-exported so consumers can read the tag attribute name from one place. */
export { TENANT_TAG_KEY };
