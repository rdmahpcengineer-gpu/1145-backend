/**
 * workflows/orchestration/failure-record — the WF-1 step-failure record shape.
 *
 * When a workflow step fails, WF-1 records a tenant-scoped failure item in the
 * DM-2 single table (design.md "Error Handling → Workflow step failures";
 * Requirement 13.4). This module owns the SHAPE of that record so it is defined
 * once and shared by:
 *
 *  - the orchestrator construct, which writes the item from Step Functions via a
 *    native DynamoDB integration (it reuses the `PK`/`SK`/`entityType` format
 *    defined here), and
 *  - tests, which build the same record to assert its shape.
 *
 * It deliberately reuses the shared `data/persistence` primitives — the
 * `TENANT#<tenantId>` partition-key builder and the {@link PersistedItem} /
 * {@link EntityType} types — so a WF-1 failure item is partitioned exactly like
 * every other durable record (design Property 3) and cannot drift from the
 * single-table contract.
 *
 * _Requirements: 13.4_
 */

import {
  EntityType,
  PersistedItem,
  tenantPartitionKey,
} from '../../data/persistence';

/** Sort-key prefix for a failure record: `FAILURE#<execId>`. */
export const FAILURE_SK_PREFIX = 'FAILURE#';

/** The entity discriminator for a WF-1 failure record in DM-2. */
export const FAILURE_ENTITY_TYPE: EntityType = 'Failure';

/** Build the DM-2 sort key for a failure record: `FAILURE#<execId>`. */
export function failureSortKey(execId: string): string {
  if (typeof execId !== 'string' || execId.length === 0) {
    throw new Error('failureSortKey requires a non-empty execution id.');
  }
  return `${FAILURE_SK_PREFIX}${execId}`;
}

/** Inputs needed to describe a failed workflow step. */
export interface WorkflowFailureInput {
  /** Operative tenant for the failed execution (propagated through every step). */
  readonly tenantId: string;
  /** The Step Functions execution id (its name) — the `<execId>` in the SK. */
  readonly execId: string;
  /** The action type being routed when the failure occurred, when known. */
  readonly actionType?: string;
  /** Step Functions error name (e.g. `States.TaskFailed`), when known. */
  readonly error?: string;
  /** Step Functions error cause (the failing step's detail), when known. */
  readonly cause?: string;
  /** ISO-8601 timestamp; defaults to now. */
  readonly createdAt?: string;
}

/**
 * Build the fully-formed DM-2 failure item. The partition key is
 * `TENANT#<tenantId>` (via the shared builder, so an invalid/missing tenant is
 * rejected before a record is shaped) and the sort key is `FAILURE#<execId>`.
 */
export function buildFailureRecord(input: WorkflowFailureInput): PersistedItem {
  const { tenantId, execId } = input;
  return {
    PK: tenantPartitionKey(tenantId),
    SK: failureSortKey(execId),
    entityType: FAILURE_ENTITY_TYPE,
    tenantId,
    data: {
      execId,
      ...(input.actionType !== undefined ? { actionType: input.actionType } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
      outcome: 'error',
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
