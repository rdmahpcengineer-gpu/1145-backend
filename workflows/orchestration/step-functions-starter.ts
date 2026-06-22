/**
 * workflows/orchestration/step-functions-starter — the concrete WF-1 client.
 *
 * This is the concrete implementation of the {@link WorkflowStarter} interface
 * the CP-2 command handlers depend on (control-plane/rest/handlers/
 * workflow-client.ts). It is an adapter over Step Functions `StartExecution`:
 * given a tenant-scoped {@link CommandEnvelope}, it classifies the command into
 * a {@link WorkflowActionType}, builds the canonical execution input
 * (`{ tenantId, actionType, payload }`), and starts a WF-1 execution.
 *
 * Tenant handling (design Properties 1 & 7):
 *  - `tenantId` is the FIRST positional argument and is the ONLY tenant written
 *    into the execution input. A mismatch between the positional `tenantId` and
 *    the envelope's `tenantId` is rejected, so a command cannot be started under
 *    a tenant other than the one derived from its Validated_Session.
 *  - that single `tenantId` becomes the root of the execution input, so it rides
 *    every downstream state's input (the state machine never reassigns it).
 *
 * The adapter depends on a narrow {@link StartExecutionClient} rather than the
 * AWS SDK, so it is unit-testable with a fake and carries no cloud coupling at
 * compile time; a thin SDK adapter (`@aws-sdk/client-sfn`) is injected at deploy
 * time inside the Lambda bundle.
 *
 * _Requirements: 2.4, 7.4, 13.2, 13.3_
 */

import {
  CommandEnvelope,
  ExecutionRef,
  WorkflowStarter,
} from '../../control-plane/rest/handlers/workflow-client';
import {
  PAYLOAD_FIELD,
  TENANT_ID_FIELD,
  WorkflowActionType,
} from './action';
import { workflowActionTypeFromCommand } from './routing';

/** Narrow input to a Step Functions `StartExecution` call. */
export interface StartExecutionInput {
  readonly stateMachineArn: string;
  /** Execution name — becomes the `<execId>` in any `FAILURE#<execId>` record. */
  readonly name: string;
  /** JSON-serialized execution input. */
  readonly input: string;
}

/** Narrow result of a Step Functions `StartExecution` call. */
export interface StartExecutionOutput {
  readonly executionArn: string;
  readonly startDate?: Date;
}

/** The minimal Step Functions surface the starter needs (decoupled from the SDK). */
export interface StartExecutionClient {
  startExecution(input: StartExecutionInput): Promise<StartExecutionOutput>;
}

/** Dependencies for {@link StepFunctionsWorkflowStarter}. */
export interface StepFunctionsWorkflowStarterDeps {
  /** ARN of the WF-1 state machine (from shared/wiring). */
  readonly stateMachineArn: string;
  /** Step Functions client adapter. */
  readonly client: StartExecutionClient;
  /**
   * Override how a command maps to an action type. Defaults to
   * {@link workflowActionTypeFromCommand}.
   */
  readonly actionTypeResolver?: (command: CommandEnvelope) => WorkflowActionType;
  /** Override execution-name generation (useful for deterministic tests). */
  readonly nameFactory?: () => string;
}

/** Thrown when the positional tenant disagrees with the envelope's tenant. */
export class TenantMismatchError extends Error {
  constructor(positional: string, envelope: string) {
    super(
      `Refusing to start WF-1: positional tenantId ${JSON.stringify(positional)} ` +
        `does not match command envelope tenantId ${JSON.stringify(envelope)}.`,
    );
    this.name = 'TenantMismatchError';
    Object.setPrototypeOf(this, TenantMismatchError.prototype);
  }
}

/** Sanitize a candidate Step Functions execution name to the allowed charset. */
export function sanitizeExecutionName(candidate: string): string {
  // Step Functions execution names: 1–80 chars, no whitespace or control chars
  // and none of: <space> < > { } [ ] ? * " # % \ ^ | ~ ` $ & , ; : /
  const cleaned = candidate.replace(/[\s<>{}\[\]?*"#%\\^|~`$&,;:/]/g, '-');
  return cleaned.slice(0, 80) || 'wf1';
}

/** Default execution-name factory: `wf1-<timestamp>-<random>`. */
function defaultExecutionName(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return sanitizeExecutionName(`wf1-${Date.now()}-${rand}`);
}

/**
 * Build the canonical WF-1 execution input. `tenantId` is the root field so it
 * propagates to every state (design Property 7); `actionType` is what the
 * orchestrator's `Choice` routes on; `payload` is the opaque contract payload.
 */
export function buildExecutionInput(
  tenantId: string,
  actionType: WorkflowActionType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    [TENANT_ID_FIELD]: tenantId,
    actionType,
    [PAYLOAD_FIELD]: payload ?? {},
  };
}

/**
 * The concrete WF-1 orchestrator client an adapter over Step Functions
 * `StartExecution`. Wired into the CP-2 command handler (task 6.2) at deploy
 * time so an authorized command routes to WF-1.
 */
export class StepFunctionsWorkflowStarter implements WorkflowStarter {
  private readonly resolveActionType: (command: CommandEnvelope) => WorkflowActionType;
  private readonly nameFactory: () => string;

  constructor(private readonly deps: StepFunctionsWorkflowStarterDeps) {
    if (!deps.stateMachineArn) {
      throw new Error('StepFunctionsWorkflowStarter requires a stateMachineArn.');
    }
    this.resolveActionType = deps.actionTypeResolver ?? workflowActionTypeFromCommand;
    this.nameFactory = deps.nameFactory ?? defaultExecutionName;
  }

  async start(tenantId: string, command: CommandEnvelope): Promise<ExecutionRef> {
    // Tenant safety: the only tenant we ever start under is the positional one
    // (derived from the Validated_Session). It must agree with the envelope.
    if (tenantId !== command.tenantId) {
      throw new TenantMismatchError(tenantId, command.tenantId);
    }

    const actionType = this.resolveActionType(command);
    const name = sanitizeExecutionName(this.nameFactory());
    const input = buildExecutionInput(tenantId, actionType, command.payload);

    const result = await this.deps.client.startExecution({
      stateMachineArn: this.deps.stateMachineArn,
      name,
      input: JSON.stringify(input),
    });

    return { executionId: name, executionArn: result.executionArn };
  }
}
