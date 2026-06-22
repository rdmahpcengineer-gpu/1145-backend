/**
 * workflows/orchestration — WF-1 orchestrator runtime domain.
 *
 * Pure, cloud-decoupled logic the WF-1 state machine and its clients share:
 * the action model, the action→service routing table (design Property 15), the
 * tenant-scoped failure-record shape (Requirement 13.4), and the concrete
 * `WorkflowStarter` adapter over Step Functions `StartExecution`.
 */
export * from './action';
export * from './routing';
export * from './failure-record';
export * from './step-functions-starter';
