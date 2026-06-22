/**
 * data/embedding — DM-3 tenant-scoped embedding store.
 *
 * Exposes both the access logic (tagging + tenant-restricted similarity search)
 * and the CDK construct that provisions pgvector on Aurora.
 */
export * from './embedding_store';
export * from './embedding-store-construct';
