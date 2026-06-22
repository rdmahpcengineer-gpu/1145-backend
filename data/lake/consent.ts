/**
 * data/lake/consent — the backend-enforced recording-consent gate (A1).
 *
 * Assumption A1 (design.md): the BACKEND enforces the recording-consent gate
 * itself. A consent signal arriving from the voice edge over SE-1 is treated as
 * INPUT that is recorded into the persisted `CONSENT#<callId>` record — never as
 * authorization. Immediately before any audio `PutObject`, the object-lake
 * module asks this gate whether consent for the caller's jurisdiction has been
 * captured, and the gate reads ONLY the persisted record.
 *
 * The gate FAILS CLOSED: absent, denied, or ambiguous consent yields a non-
 * "granted" decision and no audio is stored (R20.2, design Property 21, Error
 * Handling "Consent ambiguity").
 *
 * The consent record is read tenant-scoped through the shared DM-2 query
 * builder (`data/query/tenant_query`), pinned to `PK = TENANT#<tenantId>` and
 * `SK = CONSENT#<callId>`, so a consent lookup can never cross tenants.
 *
 * _Requirements: 20.2, 20.3_
 */

import {
  DynamoQueryExecutor,
  queryTenant,
} from '../query/tenant_query';

/** SK prefix for consent records in the DM-2 single table. */
export const CONSENT_SK_PREFIX = 'CONSENT#';

/** Build the consent record's sort key: `CONSENT#<callId>`. */
export function consentSortKey(callId: string): string {
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new Error('consentSortKey requires a non-empty callId.');
  }
  return `${CONSENT_SK_PREFIX}${callId}`;
}

/** Per-jurisdiction consent state captured for a Call. */
export interface JurisdictionConsent {
  /**
   * Captured consent status. Only the exact value `'granted'` authorizes
   * audio storage; any other / missing value is treated conservatively.
   */
  readonly status?: 'granted' | 'denied' | string;
  /** ISO-8601 time the consent input was captured (informational). */
  readonly capturedAt?: string;
  /**
   * Where the consent signal came from (e.g. `'edge'`). Recorded as INPUT to
   * the gate, not as authorization — the gate never trusts this to bypass.
   */
  readonly source?: string;
}

/** The `data` payload of a persisted `CONSENT#<callId>` record. */
export interface ConsentRecordData {
  /** Per-jurisdiction consent input, keyed by jurisdiction identifier. */
  readonly jurisdictions?: Record<string, JurisdictionConsent>;
}

/** The decision the gate returns for a (call, jurisdiction). */
export type ConsentDecision = 'granted' | 'denied' | 'absent' | 'ambiguous';

/**
 * Pure decision function: given the persisted consent record `data` (or
 * `undefined` when no record exists) and the caller's `jurisdiction`, decide
 * whether audio may be stored.
 *
 * Fail-closed semantics:
 *   - no record / no jurisdictions map / jurisdiction not present  -> 'absent'
 *   - explicit `status === 'denied'`                               -> 'denied'
 *   - explicit `status === 'granted'`                              -> 'granted'
 *   - anything else (unknown/missing status)                       -> 'ambiguous'
 *
 * Only `'granted'` permits storage.
 */
export function evaluateConsent(
  record: ConsentRecordData | undefined,
  jurisdiction: string,
): ConsentDecision {
  if (typeof jurisdiction !== 'string' || jurisdiction.length === 0) {
    // No resolvable jurisdiction -> cannot prove consent -> fail closed.
    return 'ambiguous';
  }
  const map = record?.jurisdictions;
  if (!map || typeof map !== 'object') {
    return 'absent';
  }
  const entry = map[jurisdiction];
  if (!entry || typeof entry !== 'object') {
    return 'absent';
  }
  if (entry.status === 'granted') return 'granted';
  if (entry.status === 'denied') return 'denied';
  return 'ambiguous';
}

/** True iff the decision authorizes storing audio (only `'granted'`). */
export function isConsentGranted(decision: ConsentDecision): boolean {
  return decision === 'granted';
}

/**
 * Reads the persisted consent record for a (tenant, call). Decoupled from the
 * data plane so the object-lake module is unit-testable; a runtime adapter
 * implements it over the DM-2 query builder.
 */
export interface ConsentReader {
  read(args: {
    tenantId: string;
    callId: string;
  }): Promise<ConsentRecordData | undefined>;
}

/**
 * Default {@link ConsentReader} backed by the shared tenant query builder.
 *
 * Issues a tenant-scoped query pinned to `PK = TENANT#<tenantId>` and
 * `SK = CONSENT#<callId>`, then returns the record's `data` payload. The query
 * builder guarantees the read is tenant-scoped and filters out any
 * cross-tenant item (defense in depth).
 */
export class DynamoConsentReader implements ConsentReader {
  constructor(
    private readonly executor: DynamoQueryExecutor,
    private readonly tableName: string,
  ) {
    if (!tableName) {
      throw new Error('DynamoConsentReader requires a non-empty table name.');
    }
  }

  async read(args: {
    tenantId: string;
    callId: string;
  }): Promise<ConsentRecordData | undefined> {
    const { items } = await queryTenant<Record<string, unknown>>(
      this.executor,
      this.tableName,
      {
        tenantId: args.tenantId,
        sortKey: { kind: 'equals', value: consentSortKey(args.callId) },
        consistentRead: true,
        limit: 1,
      },
    );
    const record = items[0];
    if (!record) return undefined;
    const data = record['data'];
    return (data && typeof data === 'object'
      ? (data as ConsentRecordData)
      : {}) as ConsentRecordData;
  }
}
