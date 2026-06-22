/**
 * workflows/orchestration/routing — WF-1 action → service routing.
 *
 * The pure decision function behind design Property 15 ("Orchestrator routes
 * each action to its matching service"). The Step Functions `Choice` state in
 * the orchestrator construct mirrors this table exactly, so the deployed
 * routing and this in-process function stay in lockstep.
 *
 * It also maps a CP-2 {@link CommandEnvelope} (or any path-bearing command) to a
 * {@link WorkflowActionType}, which is how the {@link StepFunctionsWorkflowStarter}
 * decides which branch an authorized CP-2 command takes.
 *
 * _Requirements: 13.2_
 */

import { CommandEnvelope } from '../../control-plane/rest/handlers/workflow-client';
import {
  UnknownActionError,
  WORKFLOW_ACTION_TYPES,
  WorkflowActionType,
  isWorkflowActionType,
} from './action';

/** The logical workflow service an action is routed to. */
export type WorkflowServiceTarget =
  | 'BookingService'
  | 'OrdersService'
  | 'NotificationService';

/**
 * The single routing table. The orchestrator construct's `Choice` conditions
 * are generated from these entries so the deployed graph cannot diverge.
 */
export const ACTION_ROUTING: Readonly<
  Record<WorkflowActionType, WorkflowServiceTarget>
> = {
  booking: 'BookingService',
  order: 'OrdersService',
  notification: 'NotificationService',
};

/**
 * Route a known action type to its matching service (design Property 15).
 * Throws {@link UnknownActionError} for any unknown type so nothing is routed
 * for an action WF-1 does not recognize.
 */
export function routeActionType(actionType: string): WorkflowServiceTarget {
  if (!isWorkflowActionType(actionType)) {
    throw new UnknownActionError(`unknown action type ${JSON.stringify(actionType)}`);
  }
  return ACTION_ROUTING[actionType];
}

/**
 * Keyword fragments that map a CP-2 command route to a WF-1 action type. A
 * command's `commandType` / `resourcePath` is matched against these (the
 * imported `openapi.yaml` owns the actual paths — this only classifies them,
 * it never re-declares them).
 */
const COMMAND_KEYWORDS: ReadonlyArray<readonly [RegExp, WorkflowActionType]> = [
  [/\bbookings?\b/i, 'booking'],
  [/\borders?\b/i, 'order'],
  [/\bnotifications?\b/i, 'notification'],
];

/**
 * Classify a CP-2 command into a WF-1 action type from its route. An explicit
 * `actionType` on the payload (if a contract carries one) wins; otherwise the
 * command/route keywords decide. Throws {@link UnknownActionError} when no rule
 * matches, so an authorized-but-unroutable command surfaces a clear error
 * rather than starting an execution that goes nowhere.
 */
export function workflowActionTypeFromCommand(
  command: Pick<CommandEnvelope, 'commandType' | 'resourcePath' | 'payload'>,
): WorkflowActionType {
  const explicit = command.payload?.[ACTION_TYPE_FIELD_KEY];
  if (isWorkflowActionType(explicit)) {
    return explicit;
  }

  const haystack = `${command.commandType} ${command.resourcePath}`;
  for (const [pattern, actionType] of COMMAND_KEYWORDS) {
    if (pattern.test(haystack)) {
      return actionType;
    }
  }

  throw new UnknownActionError(
    `no action type for command ${JSON.stringify(command.commandType)} ` +
      `(${JSON.stringify(command.resourcePath)}); ` +
      `expected one of ${WORKFLOW_ACTION_TYPES.join(', ')}`,
  );
}

/** Payload field a contract may use to name the action type explicitly. */
const ACTION_TYPE_FIELD_KEY = 'actionType';
