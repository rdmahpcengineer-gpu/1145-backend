/**
 * workflows/orders/handler — the WF-3 Orders Service Lambda entrypoint.
 *
 * This is the real handler the WF-1 orchestrator routes an `order` action to
 * (replacing the placeholder in the orchestrator construct). The orchestrator
 * invokes the service Lambda with the payload:
 *
 *     { tenantId, actionType, action }
 *
 * where `tenantId` is the Validated_Session tenant propagated into every state
 * input (design Property 7), `actionType` is `"order"`, and `action` is the
 * full initiating action `{ tenantId, actionType, payload }`. The order details
 * (items + the rest) live on `action.payload`.
 *
 * The handler's only job is to adapt that event to the pure {@link createOrder}
 * domain logic and to provide a DynamoDB-backed {@link TenantPersistence} so the
 * order is written to the DM-2 single table with `PK = TENANT#<tenantId>`
 * (tenant logic reused from `data/persistence`, never re-implemented here).
 *
 * The AWS SDK v3 DynamoDB client is loaded via `require` (it is provided by the
 * Node 20 Lambda runtime) so this file carries no compile-time dependency on
 * the SDK.
 *
 * _Requirements: 15.1, 15.2, 15.3_
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import { OrderLineItem, OrderOutcome, createOrder } from './orders';

/** Environment variable carrying the DM-2 table name (wired by the stack). */
export const ORDER_TABLE_ENV = 'DM2_TABLE_NAME';

/** The shape the orchestrator delivers to the Orders service Lambda. */
export interface OrderServiceEvent {
  readonly tenantId?: string;
  readonly actionType?: string;
  readonly action?: {
    readonly tenantId?: string;
    readonly actionType?: string;
    readonly payload?: Record<string, unknown>;
  };
}

/**
 * Adapt the AWS SDK v3 DynamoDB document client to the narrow
 * {@link DynamoDocumentWriter} the persistence wrapper depends on. Loaded
 * lazily so importing this module (e.g. in tests) does not require the SDK.
 */
function dynamoDocumentWriter(): DynamoDocumentWriter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async put(input: PutItemInput): Promise<unknown> {
      // The KMS encryption context is carried on the wrapper's input for the
      // data-plane role; the table itself is KMS-encrypted (design CP-4).
      return doc.send(
        new PutCommand({
          TableName: input.TableName,
          Item: input.Item,
          ...(input.ConditionExpression
            ? { ConditionExpression: input.ConditionExpression }
            : {}),
          ...(input.ExpressionAttributeNames
            ? { ExpressionAttributeNames: input.ExpressionAttributeNames }
            : {}),
        }),
      );
    },
  };
}

/** Read the operative tenant from the event, preferring the top-level field. */
function resolveTenantId(event: OrderServiceEvent): string {
  const tenantId = event.tenantId ?? event.action?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('Order event is missing a tenantId.');
  }
  return tenantId;
}

/**
 * Normalize the `items` field off the action payload. The contract owns the
 * exact shape; here we only coerce to an array so the pure validator can do the
 * real checking (a missing/non-array value becomes `[]`, which the validator
 * rejects per R15.3).
 */
export function itemsFromPayload(
  payload: Record<string, unknown>,
): ReadonlyArray<OrderLineItem> {
  const items = payload.items;
  return Array.isArray(items) ? (items as OrderLineItem[]) : [];
}

/**
 * The Lambda handler. Returns the {@link OrderOutcome} so the orchestrator's
 * task result reflects the created order. An invalid order throws an
 * {@link OrderValidationError} (R15.3), which surfaces as the action's error
 * outcome through the orchestrator's failure-handling chain.
 */
export async function handler(
  event: OrderServiceEvent,
): Promise<OrderOutcome> {
  const tableName = process.env[ORDER_TABLE_ENV];
  if (!tableName) {
    throw new Error(
      `Orders service is not configured: ${ORDER_TABLE_ENV} is unset.`,
    );
  }

  const tenantId = resolveTenantId(event);
  const payload = event.action?.payload ?? {};
  const items = itemsFromPayload(payload);

  // Order details = everything on the payload except the line items.
  const { items: _items, ...details } = payload;

  const persistence = new TenantPersistence(tableName, dynamoDocumentWriter());

  return createOrder({ tenantId, items, details }, { persistence });
}
