/**
 * workflows/booking/handler — the WF-2 Booking Service Lambda entrypoint.
 *
 * This is the real handler the WF-1 orchestrator routes a `booking` action to
 * (replacing the placeholder in the orchestrator construct). The orchestrator
 * invokes the service Lambda with the payload:
 *
 *     { tenantId, actionType, action }
 *
 * where `tenantId` is the Validated_Session tenant propagated into every state
 * input (design Property 7), `actionType` is `"booking"`, and `action` is the
 * full initiating action `{ tenantId, actionType, payload }`. The booking
 * details (slot + the rest) live on `action.payload`.
 *
 * The handler's only job is to adapt that event to the pure
 * {@link createBooking} domain logic and to provide a DynamoDB-backed
 * {@link TenantPersistence} so the booking is written to the DM-2 single table
 * with `PK = TENANT#<tenantId>` (tenant logic reused from `data/persistence`,
 * never re-implemented here).
 *
 * The AWS SDK v3 DynamoDB client is loaded via `require` (it is provided by the
 * Node 20 Lambda runtime) so this file carries no compile-time dependency on
 * the SDK.
 *
 * _Requirements: 14.1, 14.2, 14.3_
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import {
  BookingOutcome,
  SlotAvailabilityChecker,
  createBooking,
} from './booking';

/** Environment variable carrying the DM-2 table name (wired by the stack). */
export const BOOKING_TABLE_ENV = 'DM2_TABLE_NAME';

/** The shape the orchestrator delivers to the Booking service Lambda. */
export interface BookingServiceEvent {
  readonly tenantId?: string;
  readonly actionType?: string;
  readonly action?: {
    readonly tenantId?: string;
    readonly actionType?: string;
    readonly payload?: Record<string, unknown>;
  };
}

/**
 * Default availability seam. A real calendar/scheduling integration replaces
 * this; until then the slot is treated as available UNLESS the action payload
 * explicitly signals otherwise (`slotAvailable === false`), which keeps the
 * R14.3 "unavailable" path reachable end-to-end.
 */
export function payloadAvailabilityChecker(
  payload: Record<string, unknown>,
): SlotAvailabilityChecker {
  return {
    isAvailable: () => payload.slotAvailable !== false,
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
function resolveTenantId(event: BookingServiceEvent): string {
  const tenantId = event.tenantId ?? event.action?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('Booking event is missing a tenantId.');
  }
  return tenantId;
}

/**
 * The Lambda handler. Returns the {@link BookingOutcome} so the orchestrator's
 * task result reflects whether the booking was created or the slot was
 * unavailable.
 */
export async function handler(
  event: BookingServiceEvent,
): Promise<BookingOutcome> {
  const tableName = process.env[BOOKING_TABLE_ENV];
  if (!tableName) {
    throw new Error(
      `Booking service is not configured: ${BOOKING_TABLE_ENV} is unset.`,
    );
  }

  const tenantId = resolveTenantId(event);
  const payload = event.action?.payload ?? {};
  const slot = typeof payload.slot === 'string' ? payload.slot : '';

  // Booking details = everything on the payload except the routing/seam fields.
  const { slot: _slot, slotAvailable: _slotAvailable, ...details } = payload;

  const persistence = new TenantPersistence(tableName, dynamoDocumentWriter());

  return createBooking(
    { tenantId, slot, details },
    {
      persistence,
      availability: payloadAvailabilityChecker(payload),
    },
  );
}
