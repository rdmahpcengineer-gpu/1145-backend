/**
 * workflows/orchestration/action — the WF-1 initiating-action model.
 *
 * A single source of truth for the shape of an action the orchestrator routes
 * and for the field names the Step Functions state machine routes on. Both the
 * runtime {@link StepFunctionsWorkflowStarter} (which builds the execution
 * input) and the CDK state-machine `Choice` (which routes on the same field)
 * reference these constants so the runtime contract and the infrastructure can
 * never drift apart.
 *
 * The orchestrator routes exactly the three service actions named in the design
 * (design.md "WF-1 — Orchestrator"; Requirement 13.2): booking → Booking_Service,
 * order → Orders_Service, notification → Notification_Service.
 *
 * _Requirements: 13.2, 13.3_
 */

/** The action types WF-1 knows how to route (design Property 15). */
export const WORKFLOW_ACTION_TYPES = ['booking', 'order', 'notification'] as const;

/** A known, routable WF-1 action type. */
export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

/**
 * Field on the state-machine input the `Choice` routes on. Kept here so the
 * CDK construct and the runtime input builder agree on the JSON shape.
 */
export const ACTION_TYPE_FIELD = 'actionType';

/** Field carrying the operative tenant on EVERY state input (design Property 7). */
export const TENANT_ID_FIELD = 'tenantId';

/** Field carrying the opaque command/tool payload. */
export const PAYLOAD_FIELD = 'payload';

/**
 * A normalized, tenant-scoped action handed to WF-1, whatever its origin (the
 * AC-2 Tool Gateway or a CP-2 command). This is exactly the JSON shape used as
 * the Step Functions execution input, so `tenantId` rides every downstream
 * state's input (design Property 7).
 */
export interface WorkflowAction {
  /** Operative tenant — derived from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** Which service the orchestrator routes to. */
  readonly actionType: WorkflowActionType;
  /** Opaque payload owned by the imported contract; passed through untouched. */
  readonly payload: Record<string, unknown>;
}

/** True iff `value` is one of the known WF-1 action types. */
export function isWorkflowActionType(value: unknown): value is WorkflowActionType {
  return (
    typeof value === 'string' &&
    (WORKFLOW_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/** Thrown when an action/command cannot be mapped to a known WF-1 action type. */
export class UnknownActionError extends Error {
  constructor(detail: string) {
    super(`Cannot route to WF-1: ${detail}`);
    this.name = 'UnknownActionError';
    Object.setPrototypeOf(this, UnknownActionError.prototype);
  }
}
