import {
  EmbeddingScopeError,
  TENANT_BIND_PARAM,
  TenantEmbeddingStore,
  buildSimilaritySearch,
  filterTenantEmbeddings,
  openSearchFilter,
  sqlWhereClause,
  tagEmbedding,
} from './embedding_store';
import { TENANT_TAG_KEY, TenantTagError } from '../tagging';

const VEC = [0.1, 0.2, 0.3];

describe('embedding_store — tagEmbedding (write side, Property 22)', () => {
  it('tags an embedding with its owning tenant', () => {
    const row = tagEmbedding('acme', { id: 'chunk-1', vector: VEC });
    expect(row[TENANT_TAG_KEY]).toBe('acme');
    expect(row.id).toBe('chunk-1');
    expect(row.vector).toEqual(VEC);
  });

  it('rejects an embedding without an id', () => {
    expect(() => tagEmbedding('acme', { id: '', vector: VEC })).toThrow(TenantTagError);
  });

  it('rejects an embedding without a usable vector', () => {
    expect(() => tagEmbedding('acme', { id: '1', vector: [] })).toThrow(TenantTagError);
    expect(() =>
      tagEmbedding('acme', { id: '1', vector: [NaN] as unknown as number[] }),
    ).toThrow(TenantTagError);
  });

  it('rejects an invalid/missing tenant', () => {
    expect(() => tagEmbedding('', { id: '1', vector: VEC })).toThrow(TenantTagError);
    expect(() => tagEmbedding('a/b', { id: '1', vector: VEC })).toThrow(TenantTagError);
  });
});

describe('embedding_store — buildSimilaritySearch (read side, Req 19.3)', () => {
  it('always pins tenantId = :t as the first predicate', () => {
    const plan = buildSimilaritySearch({ tenantId: 'acme', queryVector: VEC });
    expect(plan.predicates[0]).toEqual({
      attribute: TENANT_TAG_KEY,
      param: TENANT_BIND_PARAM,
    });
    expect(plan.parameters[TENANT_BIND_PARAM]).toBe('acme');
  });

  it('defaults topK and clamps to >= 1', () => {
    expect(buildSimilaritySearch({ tenantId: 'acme', queryVector: VEC }).topK).toBe(10);
    expect(
      buildSimilaritySearch({ tenantId: 'acme', queryVector: VEC, topK: 0 }).topK,
    ).toBe(1);
    expect(
      buildSimilaritySearch({ tenantId: 'acme', queryVector: VEC, topK: 5 }).topK,
    ).toBe(5);
  });

  it('layers metadata filters on TOP of the tenant predicate', () => {
    const plan = buildSimilaritySearch({
      tenantId: 'acme',
      queryVector: VEC,
      metadataFilters: { kind: 'note' },
    });
    expect(plan.predicates).toHaveLength(2);
    expect(plan.predicates[0].attribute).toBe(TENANT_TAG_KEY);
    expect(plan.predicates[1].attribute).toBe('kind');
  });

  it('never lets a metadata filter override the tenant predicate', () => {
    const plan = buildSimilaritySearch({
      tenantId: 'acme',
      queryVector: VEC,
      // A malicious attempt to widen scope to another tenant.
      metadataFilters: { tenantId: 'other' },
    });
    expect(plan.parameters[TENANT_BIND_PARAM]).toBe('acme');
    expect(plan.predicates).toHaveLength(1);
    expect(plan.predicates[0].attribute).toBe(TENANT_TAG_KEY);
  });

  it('rejects a search without a valid tenant scope', () => {
    expect(() =>
      buildSimilaritySearch({ tenantId: '', queryVector: VEC }),
    ).toThrow(EmbeddingScopeError);
    expect(() =>
      buildSimilaritySearch({ tenantId: 'a/b', queryVector: VEC }),
    ).toThrow(EmbeddingScopeError);
  });

  it('rejects a search without a usable query vector', () => {
    expect(() =>
      buildSimilaritySearch({ tenantId: 'acme', queryVector: [] }),
    ).toThrow(EmbeddingScopeError);
  });
});

describe('embedding_store — rendering predicates', () => {
  it('renders a pgvector WHERE clause', () => {
    const plan = buildSimilaritySearch({
      tenantId: 'acme',
      queryVector: VEC,
      metadataFilters: { kind: 'note' },
    });
    expect(sqlWhereClause(plan)).toBe('tenantId = :t AND kind = :f0');
  });

  it('renders an OpenSearch term filter list', () => {
    const plan = buildSimilaritySearch({ tenantId: 'acme', queryVector: VEC });
    expect(openSearchFilter(plan)).toEqual([{ term: { tenantId: 'acme' } }]);
  });
});

describe('embedding_store — filterTenantEmbeddings (defense in depth)', () => {
  it('drops rows belonging to other tenants', () => {
    const rows = [
      { id: '1', tenantId: 'acme' },
      { id: '2', tenantId: 'other' },
      { id: '3', tenantId: 'acme' },
      { id: '4' }, // untagged
    ];
    const kept = filterTenantEmbeddings('acme', rows);
    expect(kept.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('returns [] for empty/undefined input', () => {
    expect(filterTenantEmbeddings('acme', undefined)).toEqual([]);
    expect(filterTenantEmbeddings('acme', [])).toEqual([]);
  });

  it('rejects filtering without a valid tenant scope', () => {
    expect(() => filterTenantEmbeddings('', [])).toThrow(EmbeddingScopeError);
  });
});

describe('embedding_store — TenantEmbeddingStore wrapper', () => {
  it('tags on upsert and passes a tagged row to the engine', async () => {
    const upsert = jest.fn(async () => undefined);
    const store = new TenantEmbeddingStore({ upsert, search: jest.fn() });
    const row = await store.upsert('acme', { id: '1', vector: VEC });
    expect(row[TENANT_TAG_KEY]).toBe('acme');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'acme' }));
  });

  it('searches with a tenant-pinned plan and filters cross-tenant rows out', async () => {
    const search = jest.fn(async () => [
      { id: '1', tenantId: 'acme' },
      { id: '2', tenantId: 'other' },
    ]);
    const store = new TenantEmbeddingStore({ upsert: jest.fn(), search });
    const results = await store.search<{ id: string; tenantId: string }>({
      tenantId: 'acme',
      queryVector: VEC,
    });
    expect(results.map((r) => r.id)).toEqual(['1']);
    // The plan handed to the engine carries the mandatory tenant predicate.
    const plan: any = (search.mock.calls as any[])[0]?.[0];
    expect(plan.parameters[TENANT_BIND_PARAM]).toBe('acme');
  });

  it('refuses to upsert for an invalid tenant', async () => {
    const store = new TenantEmbeddingStore({ upsert: jest.fn(), search: jest.fn() });
    await expect(store.upsert('a/b', { id: '1', vector: VEC })).rejects.toThrow(
      TenantTagError,
    );
  });

  it('refuses to search without a tenant scope', async () => {
    const store = new TenantEmbeddingStore({ upsert: jest.fn(), search: jest.fn() });
    await expect(store.search({ tenantId: '', queryVector: VEC })).rejects.toThrow(
      EmbeddingScopeError,
    );
  });
});
