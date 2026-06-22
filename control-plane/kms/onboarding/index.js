'use strict';

/**
 * TenantProvisioning onboarding Lambda (CP-4).
 *
 * Invoked at tenant onboarding time to create that tenant's dedicated symmetric
 * KMS key. Keys are created here, per tenant, rather than statically at synth —
 * so the key set scales with the tenant population (design.md CP-4).
 *
 * For tenant T it:
 *   1. validates the tenantId,
 *   2. creates a symmetric encrypt/decrypt KMS key whose key policy grants
 *      encrypt/decrypt ONLY to that tenant's operator roles, and only while the
 *      request carries the encryption context `tenant == T` (no cross-tenant
 *      grants),
 *   3. registers the alias `alias/tenant/<T>` pointing at the key.
 *
 * Idempotent: if `alias/tenant/<T>` already exists, the existing key is
 * returned instead of creating a duplicate.
 *
 * Uses the AWS SDK v3 KMS client bundled with the Lambda Node.js runtime; this
 * file is shipped as a plain-JS asset (not compiled by the repo's tsc).
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */

const {
  KMSClient,
  CreateKeyCommand,
  CreateAliasCommand,
  DescribeKeyCommand,
  PutKeyPolicyCommand,
} = require('@aws-sdk/client-kms');

const ALIAS_PREFIX = process.env.TENANT_KEY_ALIAS_PREFIX || 'alias/tenant/';
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const kms = new KMSClient({});

function aliasForTenant(tenantId) {
  return `${ALIAS_PREFIX}${tenantId}`;
}

function operatorRoleArns() {
  try {
    const parsed = JSON.parse(process.env.TENANT_OPERATOR_ROLE_ARNS || '[]');
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === 'string') : [];
  } catch (_e) {
    return [];
  }
}

/**
 * Build a key policy that:
 *  - keeps the account root as key administrator (so the key is never orphaned),
 *  - grants the tenant's operator roles the data-plane actions, BUT only when
 *    the request's encryption context names this exact tenant. A shared role
 *    operating in another tenant's context therefore cannot use this key.
 */
function buildKeyPolicy(tenantId, accountId, partition) {
  const statements = [
    {
      Sid: 'EnableRootAdministration',
      Effect: 'Allow',
      Principal: { AWS: `arn:${partition}:iam::${accountId}:root` },
      Action: 'kms:*',
      Resource: '*',
    },
  ];

  const roles = operatorRoleArns();
  if (roles.length > 0) {
    statements.push({
      Sid: 'TenantScopedDataPlaneUse',
      Effect: 'Allow',
      Principal: { AWS: roles },
      Action: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:DescribeKey',
      ],
      Resource: '*',
      // Cryptographically pin usage to this tenant's context — no cross-tenant
      // grants, even though the operator roles may be shared across tenants.
      Condition: {
        StringEquals: { 'kms:EncryptionContext:tenant': tenantId },
      },
    });
  }

  return JSON.stringify({ Version: '2012-10-17', Id: `tenant-${tenantId}`, Statement: statements });
}

async function findExistingKeyArn(aliasName) {
  try {
    const out = await kms.send(new DescribeKeyCommand({ KeyId: aliasName }));
    return out && out.KeyMetadata ? out.KeyMetadata.Arn : undefined;
  } catch (err) {
    if (err && (err.name === 'NotFoundException' || err.name === 'NotFound')) {
      return undefined;
    }
    throw err;
  }
}

exports.handler = async function handler(event) {
  const tenantId = event && event.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      `Invalid tenantId for onboarding: ${JSON.stringify(tenantId)}. ` +
        `Expected ${TENANT_ID_PATTERN}.`,
    );
  }

  const aliasName = aliasForTenant(tenantId);

  // Idempotency: reuse an already-provisioned key for this tenant.
  const existing = await findExistingKeyArn(aliasName);
  if (existing) {
    return { tenantId, aliasName, keyArn: existing, created: false };
  }

  const accountId =
    process.env.AWS_ACCOUNT_ID ||
    (event && event.accountId) ||
    deriveAccountId(event);
  const partition = process.env.AWS_PARTITION || 'aws';

  const created = await kms.send(
    new CreateKeyCommand({
      Description: `CP-4 per-tenant key for tenant ${tenantId}`,
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeySpec: 'SYMMETRIC_DEFAULT',
      Tags: [{ TagKey: 'tenantId', TagValue: tenantId }],
    }),
  );

  const keyMetadata = created.KeyMetadata || {};
  const keyId = keyMetadata.KeyId;
  const keyArn = keyMetadata.Arn;

  // Apply the tenant-scoped key policy (CreateKey seeds a default root policy;
  // we replace it so operator-role grants are bound to this tenant's context).
  const resolvedAccountId = accountId || accountIdFromArn(keyArn);
  await kms.send(
    new PutKeyPolicyCommand({
      KeyId: keyId,
      PolicyName: 'default',
      Policy: buildKeyPolicy(tenantId, resolvedAccountId, partition),
    }),
  );

  await kms.send(
    new CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyId }),
  );

  return { tenantId, aliasName, keyArn, keyId, created: true };
};

function accountIdFromArn(arn) {
  // arn:aws:kms:<region>:<accountId>:key/<id>
  if (typeof arn !== 'string') return undefined;
  const parts = arn.split(':');
  return parts.length >= 5 ? parts[4] : undefined;
}

function deriveAccountId(event) {
  if (event && typeof event.invokedFunctionArn === 'string') {
    return accountIdFromArn(event.invokedFunctionArn);
  }
  return undefined;
}
