import {
  InvalidTenantIdError,
  TENANT_KEY_ALIAS_PREFIX,
  aliasArnForTenant,
  aliasForTenant,
  assertValidTenantId,
  encryptionContextForTenant,
  isValidTenantId,
  keyForTenant,
  resolveTenantKeyArn,
} from './tenant_key';

const CTX = { region: 'us-east-1', accountId: '111122223333' };

describe('tenant_key — validation', () => {
  it('accepts well-formed tenant ids', () => {
    expect(isValidTenantId('acme')).toBe(true);
    expect(isValidTenantId('tenant-123_AB')).toBe(true);
    expect(isValidTenantId('a')).toBe(true);
  });

  it('rejects empty, non-string, and unsafe tenant ids', () => {
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId(undefined)).toBe(false);
    expect(isValidTenantId(123 as unknown)).toBe(false);
    // No slashes — cannot escape the alias/tenant/<id> namespace.
    expect(isValidTenantId('aws/key')).toBe(false);
    expect(isValidTenantId('a/b')).toBe(false);
    // Must start alphanumeric.
    expect(isValidTenantId('-leading')).toBe(false);
    expect(isValidTenantId('with space')).toBe(false);
  });

  it('assertValidTenantId throws InvalidTenantIdError on bad input', () => {
    expect(() => assertValidTenantId('a/b')).toThrow(InvalidTenantIdError);
    expect(() => assertValidTenantId('')).toThrow(InvalidTenantIdError);
  });
});

describe('tenant_key — alias and arn derivation', () => {
  it('builds the bare alias under the tenant namespace', () => {
    expect(aliasForTenant('acme')).toBe(`${TENANT_KEY_ALIAS_PREFIX}acme`);
    expect(aliasForTenant('acme')).toBe('alias/tenant/acme');
  });

  it('builds a fully-qualified alias ARN', () => {
    expect(aliasArnForTenant('acme', CTX)).toBe(
      'arn:aws:kms:us-east-1:111122223333:alias/tenant/acme',
    );
  });

  it('honors a non-default partition', () => {
    expect(aliasArnForTenant('acme', { ...CTX, partition: 'aws-cn' })).toBe(
      'arn:aws-cn:kms:us-east-1:111122223333:alias/tenant/acme',
    );
  });

  it('keyForTenant returns the alias ARN for an explicit context', () => {
    expect(keyForTenant('acme', CTX)).toBe(
      'arn:aws:kms:us-east-1:111122223333:alias/tenant/acme',
    );
  });

  it('keyForTenant rejects invalid tenant ids', () => {
    expect(() => keyForTenant('a/b', CTX)).toThrow(InvalidTenantIdError);
  });
});

describe('tenant_key — deterministic, single-tenant mapping (R4.2/4.3)', () => {
  it('is a pure deterministic function of tenantId', () => {
    expect(keyForTenant('acme', CTX)).toBe(keyForTenant('acme', CTX));
  });

  it('maps distinct tenants to distinct keys', () => {
    expect(keyForTenant('t1', CTX)).not.toBe(keyForTenant('t2', CTX));
    expect(aliasForTenant('t1')).not.toBe(aliasForTenant('t2'));
  });

  it('the encryption context names exactly the owning tenant', () => {
    expect(encryptionContextForTenant('acme')).toEqual({ tenant: 'acme' });
  });
});

describe('tenant_key — environment fallback', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('derives region/account from the environment when no context passed', () => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_ACCOUNT_ID = '444455556666';
    expect(keyForTenant('acme')).toBe(
      'arn:aws:kms:eu-west-1:444455556666:alias/tenant/acme',
    );
  });

  it('throws a clear error when region/account cannot be resolved', () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.CDK_DEFAULT_REGION;
    delete process.env.AWS_ACCOUNT_ID;
    delete process.env.CDK_DEFAULT_ACCOUNT;
    expect(() => keyForTenant('acme')).toThrow(/region\/account/);
  });
});

describe('tenant_key — resolver indirection', () => {
  it('resolveTenantKeyArn resolves the tenant alias to a concrete key ARN', async () => {
    const resolver = {
      resolveAliasToKeyArn: jest.fn(async (alias: string) => {
        expect(alias).toBe('alias/tenant/acme');
        return 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234';
      }),
    };
    await expect(resolveTenantKeyArn('acme', resolver)).resolves.toBe(
      'arn:aws:kms:us-east-1:111122223333:key/abcd-1234',
    );
    expect(resolver.resolveAliasToKeyArn).toHaveBeenCalledTimes(1);
  });
});
