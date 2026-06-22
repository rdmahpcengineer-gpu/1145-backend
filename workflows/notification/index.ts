/**
 * workflows/notification — WF-4/5 Notification Service.
 *
 * Public surface: the pure notification domain logic (design WF-4/5) and the
 * Lambda handler the WF-1 orchestrator routes a `notification` action to.
 */
export * from './notification';
export * from './handler';
