/**
 * data/crypto/tenant_key — CP-4 per-tenant key resolver.
 *
 * Single source of truth for "which KMS key encrypts tenant T's data".
 *
 * Callers NEVER pass a raw key ARN. They always resolve through
 * {@link keyForTenant} / {@link aliasForTenant}, so a mismatched tenant/key
 * pairing is structurally impossible: the key is derived from the SAME
 * `tenantId` used to build the DynamoDB partition key `TENANT#<tenantId>`
 * (design.md, CP-4; multi-tenant isolation rule 4).
 *
 * Keys are provisioned at tenant onboarding time by the `TenantProvisioning`
 * onboarding Lambda under the alias `alias/tenant/<tenantId>` — not statically
 * at synth time — so the key set scales with the tenant population. This
 * resolver therefore addresses keys by their well-known alias and does not need
 * to know per-tenant key ids ahead of time.
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */

/** The alias namespace under which every per-tenant CP-4 key is registered. */
export const TENANT_KEY_ALIAS_PREFIX = 'alias/tenant/';

/**
 * Allowed shape of a `tenantId` when embedded in a KMS alias.
 *
 * KMS alias names must match `^[a-zA-Z0-9/_-]+$`; we additionally forbid `/`
 * inside the tenant segment so a tenantId can never escape the
 * `alias/tenant/<tenantId>` namespace (e.g. inject `aws/...` or a second
 * tenant's path). 1–128 chars, must start alphanumeric.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** AWS placement needed to build a fully-qualified alias ARN. */
export interface AwsContext {
  readonly region: string;
  readonly accountId: string;
  /** AWS partition; defaults to `aws`. */
  readonly partition?: string;
}

/** Thrown when a tenantId cannot be safely turned into a key reference. */
export class InvalidTenantIdError extends Error {
  constructor(tenantId: unknown) {
    super(
      `Invalid tenantId for key resolution: ${JSON.stringify(tenantId)}. ` +
        `Expected ${TENANT_ID_PATTERN} (1-128 chars, alphanumeric/_/-, no slashes).`,
    );
    this.name = 'InvalidTenantIdError';
  }
}

/** True iff `tenantId` is a non-empty string safe to embed in a tenant alias. */
export function isValidTenantId(tenantId: unknown): tenantId is string {
  return typeof tenantId === 'string' && TENANT_ID_PATTERN.test(tenantId);
}

/** Assert `tenantId` is valid, narrowing its type; throws otherwise. */
export function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (!isValidTenantId(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }
}

/**
 * The bare KMS alias name for a tenant: `alias/tenant/<tenantId>`.
 *
 * This is a valid KMS *key identifier* on its own and can be passed directly as
 * `KeyId` to Encrypt/Decrypt/GenerateDataKey within the same account+region.
 * It is the region/account-independent root of the deterministic tenant→key
 * mapping that makes cross-tenant key use structurally impossible.
 */
export function aliasForTenant(tenantId: string): string {
  assertValidTenantId(tenantId);
  return `${TENANT_KEY_ALIAS_PREFIX}${tenantId}`;
}

/**
 * The fully-qualified alias ARN for a tenant's key:
 * `arn:<partition>:kms:<region>:<accountId>:alias/tenant/<tenantId>`.
 */
export function aliasArnForTenant(tenantId: string, ctx: AwsContext): string {
  const alias = aliasForTenant(tenantId);
  const partition = ctx.partition ?? 'aws';
  if (!ctx.region || !ctx.accountId) {
    throw new Error(
      'aliasArnForTenant requires an AwsContext with region and accountId.',
    );
  }
  return `arn:${partition}:kms:${ctx.region}:${ctx.accountId}:${alias}`;
}

/**
 * The KMS encryption context that MUST accompany every encrypt/decrypt of a
 * tenant's data. The per-tenant key policy is conditioned on this context
 * (`kms:EncryptionContext:tenant == <tenantId>`), so even a shared data-plane
 * role can only use tenant T's key while operating in tenant T's context.
 */
export function encryptionContextForTenant(tenantId: string): { tenant: string } {
  assertValidTenantId(tenantId);
  return { tenant: tenantId };
}

/** Resolves a KMS alias to the concrete key ARN (e.g. via the KMS API). */
export interface KmsKeyResolver {
  resolveAliasToKeyArn(aliasName: string): Promise<string>;
}

function contextFromEnv(): AwsContext {
  const region =
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    process.env.CDK_DEFAULT_REGION;
  const accountId =
    process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT;
  if (!region || !accountId) {
    throw new Error(
      'keyForTenant could not determine AWS region/account from the ' +
        'environment. Pass an explicit AwsContext, or set AWS_REGION and ' +
        'AWS_ACCOUNT_ID.',
    );
  }
  return { region, accountId };
}

/**
 * Resolve the KMS key for a tenant — the canonical entry point every caller
 * uses instead of handling raw key ARNs.
 *
 * Returns the tenant key's **alias ARN**
 * (`arn:aws:kms:<region>:<account>:alias/tenant/<tenantId>`), which KMS accepts
 * as a `KeyId` for encrypt/decrypt/generate-data-key. The mapping is a pure,
 * deterministic function of `tenantId`, so the key resolved for tenant T1 is
 * always T1's key and never another tenant's (design Property 8).
 *
 * @param tenantId the tenant whose key is needed (same id used for `PK`)
 * @param context  AWS region/account; falls back to the process environment
 */
export function keyForTenant(tenantId: string, context?: AwsContext): string {
  assertValidTenantId(tenantId);
  return aliasArnForTenant(tenantId, context ?? contextFromEnv());
}

/**
 * Resolve a tenant's alias to its concrete underlying key ARN via a KMS
 * resolver (use when an operation requires the literal key ARN rather than the
 * alias). The alias is still derived from `tenantId`, preserving the
 * deterministic tenant→key guarantee.
 */
export async function resolveTenantKeyArn(
  tenantId: string,
  resolver: KmsKeyResolver,
): Promise<string> {
  return resolver.resolveAliasToKeyArn(aliasForTenant(tenantId));
}
