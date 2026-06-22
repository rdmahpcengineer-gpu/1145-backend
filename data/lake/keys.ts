/**
 * data/lake/keys — DM-4 object-key layout.
 *
 * Single source of truth for the object-lake key layout
 * (design.md "Data Models"; multi-tenant isolation rule 1 applied to S3):
 *
 *   <tenantId>/recordings/<callId>/<name>   (Call audio)
 *   <tenantId>/docs/<name>                  (tenant documents)
 *
 * Every key produced here is prefixed by the OWNING tenant id, so an object
 * can never be written outside its tenant's prefix (design Property 20). The
 * `tenantId` is validated by the SAME rule used for the DynamoDB partition key
 * and the CP-4 KMS alias (`data/crypto/tenant_key`), so the prefix, the
 * encryption key, and the table partition all agree on one notion of "tenant".
 *
 * _Requirements: 20.1_
 */

import { assertValidTenantId } from '../crypto/tenant_key';
import { ObjectKeyError } from './errors';

/** Top-level object classes within a tenant's prefix. */
export const RECORDINGS_SEGMENT = 'recordings';
export const DOCS_SEGMENT = 'docs';

/**
 * Allowed shape of a single path component (callId, object name). Forbids `/`
 * so a component can never inject extra path segments and escape its tenant
 * prefix, and forbids leading dots / control characters. 1–256 chars.
 */
const PATH_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=+-]{0,255}$/;

/** The tenant prefix every object key begins with: `<tenantId>/`. */
export function tenantPrefix(tenantId: string): string {
  try {
    assertValidTenantId(tenantId);
  } catch {
    throw new ObjectKeyError(
      'invalid-tenant-id',
      `Cannot build an object key for an invalid tenantId: ${JSON.stringify(
        tenantId,
      )}.`,
    );
  }
  return `${tenantId}/`;
}

function assertPathComponent(
  value: unknown,
  violation: 'missing-call-id' | 'missing-object-name' | 'invalid-object-name',
  label: string,
): asserts value is string {
  if (value === undefined || value === null || value === '') {
    throw new ObjectKeyError(
      violation === 'invalid-object-name' ? 'missing-object-name' : violation,
      `Cannot build an object key without a ${label}.`,
    );
  }
  if (typeof value !== 'string' || !PATH_COMPONENT_PATTERN.test(value)) {
    throw new ObjectKeyError(
      'invalid-object-name',
      `Invalid ${label} for an object key: ${JSON.stringify(value)}. ` +
        `Expected ${PATH_COMPONENT_PATTERN} (no slashes).`,
    );
  }
}

/**
 * Build the key for a Call recording:
 * `<tenantId>/recordings/<callId>/<name>`.
 */
export function recordingKey(args: {
  tenantId: string;
  callId: string;
  name: string;
}): string {
  const prefix = tenantPrefix(args.tenantId);
  assertPathComponent(args.callId, 'missing-call-id', 'callId');
  assertPathComponent(args.name, 'missing-object-name', 'object name');
  return `${prefix}${RECORDINGS_SEGMENT}/${args.callId}/${args.name}`;
}

/**
 * Build the key for a tenant document: `<tenantId>/docs/<name>`.
 */
export function documentKey(args: { tenantId: string; name: string }): string {
  const prefix = tenantPrefix(args.tenantId);
  assertPathComponent(args.name, 'missing-object-name', 'object name');
  return `${prefix}${DOCS_SEGMENT}/${args.name}`;
}

/** True iff `key` is under tenant `tenantId`'s prefix (`<tenantId>/...`). */
export function isUnderTenantPrefix(tenantId: string, key: unknown): boolean {
  if (typeof key !== 'string') return false;
  let prefix: string;
  try {
    prefix = tenantPrefix(tenantId);
  } catch {
    return false;
  }
  return key.startsWith(prefix) && key.length > prefix.length;
}
