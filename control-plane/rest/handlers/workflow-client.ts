/**
 * control-plane/rest/handlers/workflow-client — the narrow WF-1 client the CP-2
 * command handlers depend on.
 *
 * Task 6.2 must route authorized CP-2 commands to the WF-1 orchestrator
 * (R2.4), but WF-1 itself is not built until task 14.1. To keep the two
 * decoupled — and to keep the handler unit-testable without standing up Step
 * Functions/EventBridge — the handler depends ONLY on this minimal interface,
 * not on any concrete orchestrator or AWS SDK type. The `WorkflowStack` task
 * (14.1) will provide the concrete implementation (an adapter over
 * `StartExecution` / `PutEvents`) and wire it in.
 *
 * This mirrors the design's WF-1 surface — `start(tenantId, action) ->
 * executionArn` (design.md "WF-1 — Orchestrator") — narrowed to exactly what a
 * CP-2 command needs.
 *
 * _Requirements: 2.4_
 */

/**
 * A normalized, tenant-scoped command extracted from a CP-2 request and ready
 * to hand to WF-1. The `tenantId` is carried separately on
 * {@link WorkflowStarter.start} (it is always the FIRST positional argument so
 * a caller cannot forget to scope), but it is also stamped on the envelope so
 * downstream state inputs are self-describing (design Property 7: tenant
 * propagates unchanged across tool → workflow → steps).
 */
export interface CommandEnvelope {
  /**
   * Operative tenant for this command — derived from the CP-1 Validated_Session
   * by the handler, NEVER from a client-supplied field (design Property 1).
   */
  readonly tenantId: string;
  /**
   * A stable identifier for the kind of command, derived from the matched
   * route (e.g. `POST /commands/bookings`). The handler does not re-author the
   * imported `openapi.yaml`; it only derives this routing key from the path the
   * gateway already validated and matched.
   */
  readonly commandType: string;
  /** HTTP method the command arrived on (upper-cased). */
  readonly method: string;
  /** The matched resource path (e.g. `/commands/bookings`). */
  readonly resourcePath: string;
  /**
   * The request payload, parsed from the (contract-validated) request body. Its
   * shape is owned by the imported `openapi.yaml` — it is passed through opaque
   * here and never re-declared.
   */
  readonly payload: Record<string, unknown>;
}

/**
 * A reference to the workflow execution WF-1 started for a command. Kept
 * deliberately small so the concrete WF-1 implementation (task 14.1) can
 * populate it from a Step Functions `StartExecution` result without this
 * module depending on the AWS SDK.
 */
export interface ExecutionRef {
  /** An identifier for the started execution (e.g. Step Functions name). */
  readonly executionId: string;
  /** The execution ARN, when available. */
  readonly executionArn?: string;
}

/**
 * The WF-1 orchestrator entry point, as consumed by CP-2 command handlers.
 *
 * The concrete implementation is provided by the WorkflowStack (task 14.1); the
 * handler is injected with whatever satisfies this interface, so it can be
 * exercised in tests with a fake.
 */
export interface WorkflowStarter {
  /**
   * Route an authorized, tenant-scoped command to WF-1 for fulfillment.
   *
   * @param tenantId the operative tenant, derived from the Validated_Session.
   *                 It is the first argument so the call is structurally
   *                 tenant-scoped (design Property 7).
   * @param command  the normalized command envelope (already carries the same
   *                 `tenantId`).
   * @returns a reference to the started workflow execution.
   */
  start(tenantId: string, command: CommandEnvelope): Promise<ExecutionRef>;
}
