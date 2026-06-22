import {
  TENANT_TAG_KEY,
  TenantTagError,
  assertTenantTagged,
  isTenantTagged,
  tagWithTenant,
  tenantTagOf,
} from './tenant_tag';

describe('tenant_tag — tagWithTenant', () => {
  it('stamps the owning tenant under the tenantId tag', () => {
    const tagged = tagWithTenant('acme', { id: '1', value: 7 });
    expect(tagged[TENANT_TAG_KEY]).toBe('acme');
    expect(tagged.id).toBe('1');
    expect(tagged.value).toBe(7);
  });

  it('does not mutate the input record', () => {
    const input = { id: '1' };
    tagWithTenant('acme', input);
    expect((input as Record<string, unknown>)[TENANT_TAG_KEY]).toBeUndefined();
  });

  it('is idempotent when the existing tag already matches', () => {
    const once = tagWithTenant('acme', { id: '1' });
    const twice = tagWithTenant('acme', once);
    expect(twice[TENANT_TAG_KEY]).toBe('acme');
  });

  it('rejects a missing tenantId', () => {
    expect(() => tagWithTenant('', { id: '1' })).toThrow(TenantTagError);
    expect(() => tagWithTenant(undefined as unknown as string, { id: '1' })).toThrow(
      TenantTagError,
    );
  });

  it('rejects an invalid tenantId (no escaping the namespace)', () => {
    expect(() => tagWithTenant('a/b', { id: '1' })).toThrow(TenantTagError);
    expect(() => tagWithTenant('with space', { id: '1' })).toThrow(TenantTagError);
  });

  it('rejects re-tagging a record that already belongs to another tenant', () => {
    const owned = tagWithTenant('t1', { id: '1' });
    expect(() => tagWithTenant('t2', owned)).toThrow(TenantTagError);
    try {
      tagWithTenant('t2', owned);
    } catch (e) {
      expect((e as TenantTagError).violation).toBe('tenant-mismatch');
    }
  });

  it('rejects a non-object record', () => {
    expect(() => tagWithTenant('acme', null as unknown as Record<string, unknown>)).toThrow(
      TenantTagError,
    );
  });
});

describe('tenant_tag — inspection helpers', () => {
  it('tenantTagOf returns the tag for a well-formed record', () => {
    expect(tenantTagOf({ tenantId: 'acme' })).toBe('acme');
  });

  it('tenantTagOf returns undefined for untagged/invalid records', () => {
    expect(tenantTagOf({})).toBeUndefined();
    expect(tenantTagOf({ tenantId: 'a/b' })).toBeUndefined();
    expect(tenantTagOf(null)).toBeUndefined();
    expect(tenantTagOf(42)).toBeUndefined();
  });

  it('isTenantTagged reflects whether a valid tag is present', () => {
    expect(isTenantTagged({ tenantId: 'acme' })).toBe(true);
    expect(isTenantTagged({})).toBe(false);
  });
});

describe('tenant_tag — assertTenantTagged (the persist/ingest gate)', () => {
  it('passes a well-formed tagged record', () => {
    expect(() => assertTenantTagged({ tenantId: 'acme', id: '1' })).not.toThrow();
  });

  it('rejects an untagged record', () => {
    expect(() => assertTenantTagged({ id: '1' } as Record<string, unknown>)).toThrow(
      TenantTagError,
    );
    try {
      assertTenantTagged({ id: '1' } as Record<string, unknown>);
    } catch (e) {
      expect((e as TenantTagError).violation).toBe('missing-tag');
    }
  });

  it('rejects an invalid tag', () => {
    try {
      assertTenantTagged({ tenantId: 'a/b' });
    } catch (e) {
      expect((e as TenantTagError).violation).toBe('invalid-tag');
    }
  });

  it('rejects a record tagged for a different tenant than expected', () => {
    try {
      assertTenantTagged({ tenantId: 't1' }, 't2');
    } catch (e) {
      expect((e as TenantTagError).violation).toBe('tenant-mismatch');
    }
  });

  it('passes when the tag matches the expected tenant', () => {
    expect(() => assertTenantTagged({ tenantId: 't1' }, 't1')).not.toThrow();
  });
});
