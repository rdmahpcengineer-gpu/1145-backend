/**
 * control-plane/rest/handlers — CP-2 command Lambda handler surface.
 *
 * The tenant-isolation + routing core behind the CP-2 `SpecRestApi`: derive the
 * tenant from the CP-1 Validated_Session (never the client), scope all
 * fulfillment to that tenant, reject non-conforming requests with a validation
 * error, and route authorized commands to the WF-1 orchestrator through a
 * narrow, injected client.
 *
 * _Requirements: 2.3, 2.4, 2.5, 2.6_
 */
export * from './workflow-client';
export * from './errors';
export * from './api-gateway';
export * from './command-handler';
