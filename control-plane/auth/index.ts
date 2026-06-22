/**
 * control-plane/auth — shared tenant-derivation choke point.
 *
 * The single place the backend turns a Validated_Session into an operative
 * `tenantId`. CP-2 handlers (task 6.x), CP-3 resolvers (task 7.x), and
 * tenant-scoped runtime paths consume this surface; the client-supplied tenant
 * is never a source of truth (design Property 1).
 */
export * from './errors';
export * from './validated-session';
export * from './tenant-derivation';
