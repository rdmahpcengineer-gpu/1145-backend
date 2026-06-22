/**
 * workflows/notification/handler — the WF-4/5 Notification Service Lambda entrypoint.
 *
 * This is the real handler the WF-1 orchestrator routes a `notification` action
 * to (replacing the placeholder in the orchestrator construct). The orchestrator
 * invokes the service Lambda with the payload:
 *
 *     { tenantId, actionType, action }
 *
 * where `tenantId` is the Validated_Session tenant propagated into every state
 * input (design Property 7), `actionType` is `"notification"`, and `action` is
 * the full initiating action `{ tenantId, actionType, payload }`. The
 * confirmation details (type, reference, contact, summary) live on
 * `action.payload`.
 *
 * The handler adapts that event to the pure {@link notify} domain logic and
 * provides the cloud seams it depends on:
 *   - an {@link EmailSender} over Amazon SES (R16.1),
 *   - an {@link SmsSender} over Amazon SNS (R16.2), and
 *   - a {@link DeliveryFailureRecorder} that durably records a failed delivery
 *     in the DM-2 single table with `PK = TENANT#<tenantId>` via the shared
 *     {@link TenantPersistence} wrapper (R16.4; tenant logic reused from
 *     `data/persistence`, never re-implemented here).
 *
 * The AWS SDK v3 clients are loaded via `require` (they are provided by the
 * Node 20 Lambda runtime) so this file carries no compile-time dependency on
 * the SDK.
 *
 * _Requirements: 16.1, 16.2, 16.3, 16.4_
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import {
  Contact,
  Confirmation,
  ConfirmationType,
  DeliveryFailure,
  DeliveryFailureRecorder,
  DeliveryResult,
  EmailMessage,
  EmailSender,
  NotificationRequest,
  SmsMessage,
  SmsSender,
  notify,
} from './notification';

/** Environment variable carrying the DM-2 table name (wired by the stack). */
export const NOTIFICATION_TABLE_ENV = 'DM2_TABLE_NAME';

/**
 * Environment variable carrying the verified SES "from" address (wired by the
 * stack). The tenant's own from-address would override this in a richer
 * tenant-config integration; until then it is a single platform sender.
 */
export const NOTIFICATION_FROM_ENV = 'NOTIFICATION_FROM_ADDRESS';

/** Sort-key prefix for a recorded notification delivery failure. */
export const NOTIFICATION_FAILURE_SK_PREFIX = 'NOTIFY_FAILURE#';

/** The shape the orchestrator delivers to the Notification service Lambda. */
export interface NotificationServiceEvent {
  readonly tenantId?: string;
  readonly actionType?: string;
  readonly action?: {
    readonly tenantId?: string;
    readonly actionType?: string;
    readonly payload?: Record<string, unknown>;
  };
}

/** Read the operative tenant from the event, preferring the top-level field. */
function resolveTenantId(event: NotificationServiceEvent): string {
  const tenantId = event.tenantId ?? event.action?.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('Notification event is missing a tenantId.');
  }
  return tenantId;
}

/**
 * Normalize the `confirmation` and `contact` off the action payload. The
 * contract owns the exact shapes; here we only coerce to objects and pin the
 * confirmation type so the pure domain logic can do the real work.
 */
export function confirmationFromPayload(
  payload: Record<string, unknown>,
): Confirmation {
  const raw =
    payload.confirmation && typeof payload.confirmation === 'object'
      ? (payload.confirmation as Record<string, unknown>)
      : payload;
  const type: ConfirmationType =
    raw.type === 'order' || payload.actionType === 'order' ? 'order' : 'booking';
  return { ...raw, type } as Confirmation;
}

/** Normalize the `contact` off the action payload (missing → empty contact). */
export function contactFromPayload(payload: Record<string, unknown>): Contact {
  const contact = payload.contact;
  return contact && typeof contact === 'object'
    ? (contact as Contact)
    : ({} as Contact);
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

/** An {@link EmailSender} backed by Amazon SES (loaded lazily). */
function sesEmailSender(fromAddress: string): EmailSender {
  return {
    async sendEmail(message: EmailMessage): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
      const client = new SESClient({});
      await client.send(
        new SendEmailCommand({
          Source: fromAddress,
          Destination: { ToAddresses: [message.to] },
          Message: {
            Subject: { Data: message.subject },
            Body: { Text: { Data: message.body } },
          },
        }),
      );
    },
  };
}

/** An {@link SmsSender} backed by Amazon SNS (loaded lazily). */
function snsSmsSender(): SmsSender {
  return {
    async sendSms(message: SmsMessage): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
      const client = new SNSClient({});
      await client.send(
        new PublishCommand({
          PhoneNumber: message.to,
          Message: message.body,
        }),
      );
    },
  };
}

/**
 * A {@link DeliveryFailureRecorder} that durably records a failed delivery in
 * the DM-2 single table, tenant-partitioned via the shared wrapper (R16.4).
 */
export function persistenceFailureRecorder(
  persistence: TenantPersistence,
): DeliveryFailureRecorder {
  return {
    async record(failure: DeliveryFailure): Promise<void> {
      await persistence.put({
        tenantId: failure.tenantId,
        entityType: 'Failure',
        sk: `${NOTIFICATION_FAILURE_SK_PREFIX}${failure.channel}#${Date.now()}`,
        data: {
          kind: 'notification-delivery-failure',
          channel: failure.channel,
          reason: failure.reason,
          outcome: 'error',
        },
      });
    },
  };
}

/**
 * The Lambda handler. Returns the {@link DeliveryResult} so the orchestrator's
 * task result reflects per-channel delivery success/failure. Delivery failures
 * are recorded (R16.4) and do NOT throw — they never roll back the already
 * confirmed booking/order.
 */
export async function handler(
  event: NotificationServiceEvent,
): Promise<DeliveryResult> {
  const tableName = process.env[NOTIFICATION_TABLE_ENV];
  if (!tableName) {
    throw new Error(
      `Notification service is not configured: ${NOTIFICATION_TABLE_ENV} is unset.`,
    );
  }
  const fromAddress = process.env[NOTIFICATION_FROM_ENV];
  if (!fromAddress) {
    throw new Error(
      `Notification service is not configured: ${NOTIFICATION_FROM_ENV} is unset.`,
    );
  }

  const tenantId = resolveTenantId(event);
  const payload = event.action?.payload ?? {};

  const request: NotificationRequest = {
    tenantId,
    confirmation: confirmationFromPayload(payload),
    contact: contactFromPayload(payload),
  };

  const persistence = new TenantPersistence(tableName, dynamoDocumentWriter());

  return notify(request, {
    email: sesEmailSender(fromAddress),
    sms: snsSmsSender(),
    failureRecorder: persistenceFailureRecorder(persistence),
  });
}
