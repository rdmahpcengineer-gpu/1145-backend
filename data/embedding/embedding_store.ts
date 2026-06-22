/**
 * data/embedding/embedding_store — DM-3 tenant-scoped embedding access logic.
 *
 * The store-side logic for the DM-3 embedding store (design.md "Data Models →
 * DM-3"). It is independent of the concrete backend (pgvector on Aurora, or
 * OpenSearch): both expose "tag every row with `tenantId`" and "every
 * similarity search carries a `tenantId = :t` predicate", so this module models
 * exactly those two rules and lets the construct pick the engine.
 *
 *   1. WRITE side  — every embedding is tenant-tagged via the shared
 *      `data/tagging` helper before it can be upserted (design Property 22).
 *   2. READ side   — every similarity search is built with a mandatory
 *      `tenantId = :t` predicate/metadata filter, and results are filtered as
 *      defense in depth so a search can never cross tenants (design Property 4,
 *      Requirement 19.3). A search with no tenant scope is rejected before any
 *      query is issued.
 *
 * _Requirements: 19.2, 19.3_
 */

import {
  TENANT_TAG_KEY,
  TenantTagError,
  TenantTagged,
  assertTenantTagged,
  tagWithTenant,
  tenantTagOf,
} from '../tagging';
import { isValidTenantId } from '../crypto/tenant_key';

/**
 * A single embedding row, before tagging. `vector` is the embedding itself;
 * `metadata` carries arbitrary attributes used for filtering/recall.
 */
export interface EmbeddingInput {
  /** Stable id for the embedded chunk (e.g. a content hash or doc-chunk id). */
  readonly id: string;
  /** The embedding vector. */
  readonly vector: readonly number[];
  /** Optional source text the vector was produced from. */
  readonly content?: string;
  /** Arbitrary recall metadata (never the authoritative tenant — that's the tag). */
  readonly metadata?: Record<string, unknown>;
}

/** An embedding row stamped with its owning tenant, ready to upsert. */
export type TaggedEmbedding = TenantTagged<EmbeddingInput>;

/**
 * Tag an embedding with its owning tenant. The returned row carries a
 * `tenantId` tag (design Property 22); a missing/invalid tenant, or an input
 * already tagged for a different tenant, is rejected with a {@link TenantTagError}
 * before the row can be stored.
 */
export function tagEmbedding(
  tenantId: string,
  embedding: EmbeddingInput,
): TaggedEmbedding {
  if (!embedding || typeof embedding !== 'object') {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to tag a null/undefined or non-object embedding.',
    );
  }
  if (typeof embedding.id !== 'string' || embedding.id.length === 0) {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to tag an embedding without a stable id.',
    );
  }
  if (
    !Array.isArray(embedding.vector) ||
    embedding.vector.length === 0 ||
    !embedding.vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new TenantTagError(
      'missing-tag',
      'Refusing to tag an embedding without a non-empty numeric vector.',
    );
  }
  return tagWithTenant(tenantId, { ...embedding });
}

/**
 * Thrown when a similarity search is attempted without a usable tenant scope.
 * Raised BEFORE any query is issued so an unscoped search never reaches the
 * embedding engine.
 */
export class EmbeddingScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingScopeError';
    Object.setPrototypeOf(this, EmbeddingScopeError.prototype);
  }
}

/** Inputs for a tenant-restricted similarity search. */
export interface SimilaritySearchInput {
  /** Operative tenant — MUST come from the session context, never a client field. */
  readonly tenantId: string;
  /** The query vector to find nearest neighbours of. */
  readonly queryVector: readonly number[];
  /** Max neighbours to return (defaults to 10). */
  readonly topK?: number;
  /**
   * Optional additional metadata equality filters, AND-ed on TOP of (never
   * instead of) the mandatory tenant predicate.
   */
  readonly metadataFilters?: Record<string, string | number | boolean>;
}

/** Reserved bind-parameter name carrying the tenant scope. */
export const TENANT_BIND_PARAM = ':t';

/**
 * A backend-neutral similarity-search plan. It always includes a mandatory
 * `tenantId = :t` predicate. The construct's runtime adapter renders this to
 * the concrete engine:
 *   - pgvector  → the SQL `WHERE` clause in {@link sqlWhereClause}
 *   - OpenSearch → the term filter in {@link openSearchFilter}
 */
export interface SimilaritySearchPlan {
  readonly tenantId: string;
  readonly queryVector: readonly number[];
  readonly topK: number;
  /** Bind parameters; always contains the tenant under {@link TENANT_BIND_PARAM}. */
  readonly parameters: Record<string, unknown>;
  /** Equality predicates that must all hold, tenant predicate first. */
  readonly predicates: ReadonlyArray<{ readonly attribute: string; readonly param: string }>;
}

const DEFAULT_TOP_K = 10;

/**
 * Build a tenant-restricted similarity-search plan. The plan ALWAYS pins
 * `tenantId = :t` as its first predicate; a missing/invalid tenant scope throws
 * {@link EmbeddingScopeError} before anything is built, so no unscoped search
 * can be produced (Requirement 19.3).
 */
export function buildSimilaritySearch(
  input: SimilaritySearchInput,
): SimilaritySearchPlan {
  if (!isValidTenantId(input?.tenantId)) {
    throw new EmbeddingScopeError(
      `A tenant scope is required for similarity search: invalid tenantId ` +
        `${JSON.stringify(input?.tenantId)}.`,
    );
  }
  if (
    !Array.isArray(input.queryVector) ||
    input.queryVector.length === 0 ||
    !input.queryVector.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new EmbeddingScopeError(
      'A non-empty numeric query vector is required for similarity search.',
    );
  }

  const topK =
    input.topK === undefined ? DEFAULT_TOP_K : Math.max(1, Math.floor(input.topK));

  const parameters: Record<string, unknown> = {
    [TENANT_BIND_PARAM]: input.tenantId,
  };
  const predicates: Array<{ attribute: string; param: string }> = [
    { attribute: TENANT_TAG_KEY, param: TENANT_BIND_PARAM },
  ];

  // Layer optional metadata filters ON TOP of the mandatory tenant predicate.
  let i = 0;
  for (const [attribute, value] of Object.entries(input.metadataFilters ?? {})) {
    if (attribute === TENANT_TAG_KEY) {
      // The tenant predicate is owned by this builder and cannot be overridden
      // or widened by a caller-supplied metadata filter.
      continue;
    }
    const param = `:f${i++}`;
    parameters[param] = value;
    predicates.push({ attribute, param });
  }

  return {
    tenantId: input.tenantId,
    queryVector: input.queryVector,
    topK,
    parameters,
    predicates,
  };
}

/** Render a plan's predicates to a pgvector SQL `WHERE` clause. */
export function sqlWhereClause(plan: SimilaritySearchPlan): string {
  return plan.predicates
    .map((p) => `${p.attribute} = ${p.param}`)
    .join(' AND ');
}

/** Render a plan's predicates to an OpenSearch bool/filter term list. */
export function openSearchFilter(
  plan: SimilaritySearchPlan,
): Array<{ term: Record<string, unknown> }> {
  return plan.predicates.map((p) => ({
    term: { [p.attribute]: plan.parameters[p.param] },
  }));
}

/**
 * Defense-in-depth result filter: drop any returned neighbour whose `tenantId`
 * tag is not exactly the requesting tenant. A row missing a resolvable tag is
 * also dropped (it cannot be proven to belong to the requesting tenant).
 *
 * Even though {@link buildSimilaritySearch} pins the tenant predicate, this
 * guarantees no cross-tenant row is ever surfaced to a caller (Requirement
 * 19.3, design Property 4).
 */
export function filterTenantEmbeddings<T extends Record<string, unknown>>(
  tenantId: string,
  rows: readonly T[] | undefined,
): T[] {
  if (!isValidTenantId(tenantId)) {
    throw new EmbeddingScopeError(
      `Cannot filter results without a valid tenant scope: ` +
        `${JSON.stringify(tenantId)}.`,
    );
  }
  if (!rows) return [];
  return rows.filter((row) => tenantTagOf(row) === tenantId);
}

/**
 * The minimal upsert/search surface a runtime adapter implements over the
 * concrete engine (pgvector/OpenSearch). The store wrapper below uses it.
 */
export interface EmbeddingEngine {
  upsert(row: TaggedEmbedding): Promise<unknown>;
  search(plan: SimilaritySearchPlan): Promise<Record<string, unknown>[]>;
}

/**
 * Thin store wrapper that enforces the DM-3 invariants around any concrete
 * engine: every upsert is tenant-tagged first, and every search is tenant-pinned
 * and result-filtered. Read/write paths (AC-3 memory, ML ingest) prefer this
 * over touching the engine directly.
 */
export class TenantEmbeddingStore {
  constructor(private readonly engine: EmbeddingEngine) {}

  /** Tag and upsert an embedding for `tenantId` (design Property 22). */
  async upsert(tenantId: string, embedding: EmbeddingInput): Promise<TaggedEmbedding> {
    const row = tagEmbedding(tenantId, embedding);
    // Re-assert the tag as a final gate before the row reaches the engine.
    assertTenantTagged(row as unknown as Record<string, unknown>, tenantId);
    await this.engine.upsert(row);
    return row;
  }

  /**
   * Run a tenant-restricted similarity search and filter results so no
   * cross-tenant neighbour is ever returned (Requirement 19.3).
   */
  async search<T extends Record<string, unknown>>(
    input: SimilaritySearchInput,
  ): Promise<T[]> {
    const plan = buildSimilaritySearch(input);
    const rows = (await this.engine.search(plan)) as T[];
    return filterTenantEmbeddings(input.tenantId, rows);
  }
}
