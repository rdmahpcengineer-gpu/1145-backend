/**
 * workflows/orders — WF-3 Orders Service.
 *
 * Public surface: the pure order domain logic (design WF-3) and the Lambda
 * handler the WF-1 orchestrator routes an `order` action to.
 */
export * from './orders';
export * from './handler';
