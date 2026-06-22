/**
 * Unit tests for the WF-4/5 Notification handler's pure adaptation helpers
 * (task 17.1).
 *
 * The `handler` entrypoint itself constructs AWS SDK clients (SES/SNS/DynamoDB)
 * at invocation time (runtime-provided), so it is exercised by integration;
 * here we test the cloud-free seams it relies on, plus the persistence-backed
 * failure recorder against a recording writer.
 */

import {
  DynamoDocumentWriter,
  PutItemInput,
  TenantPersistence,
} from '../../data/persistence';
import {
  NOTIFICATION_FAILURE_SK_PREFIX,
  NOTIFICATION_FROM_ENV,
  NOTIFICATION_TABLE_ENV,
  confirmationFromPayload,
  contactFromPayload,
  persistenceFailureRecorder,
} from './handler';

describe('confirmationFromPayload', () => {
  it('reads a nested confirmation object', () => {
    const c = confirmationFromPayload({
      confirmation: { type: 'order', referenceId: 'o-1' },
    });
    expect(c).toMatchObject({ type: 'order', referenceId: 'o-1' });
  });

  it('defaults to a booking confirmation when type is absent', () => {
    expect(confirmationFromPayload({}).type).toBe('booking');
  });

  it('treats a flat payload as the confirmation', () => {
    const c = confirmationFromPayload({ referenceId: 'bk-2', summary: 'ok' });
    expect(c).toMatchObject({ type: 'booking', referenceId: 'bk-2', summary: 'ok' });
  });
});

describe('contactFromPayload', () => {
  it('returns the contact object when present', () => {
    expect(contactFromPayload({ contact: { email: 'c@e.com' } })).toEqual({
      email: 'c@e.com',
    });
  });
  it('returns an empty contact when missing', () => {
    expect(contactFromPayload({})).toEqual({});
  });
});

describe('environment variable names', () => {
  it('names the DM-2 table and SES sender env vars', () => {
    expect(NOTIFICATION_TABLE_ENV).toBe('DM2_TABLE_NAME');
    expect(NOTIFICATION_FROM_ENV).toBe('NOTIFICATION_FROM_ADDRESS');
  });
});

class RecordingWriter implements DynamoDocumentWriter {
  readonly puts: PutItemInput[] = [];
  async put(input: PutItemInput): Promise<unknown> {
    this.puts.push(input);
    return {};
  }
}

describe('persistenceFailureRecorder', () => {
  it('persists a tenant-partitioned Failure item for a delivery failure (R16.4)', async () => {
    const writer = new RecordingWriter();
    const recorder = persistenceFailureRecorder(
      new TenantPersistence('dm2-table', writer),
    );

    await recorder.record({ tenantId: 'tenant-abc', channel: 'sms', reason: 'sns down' });

    expect(writer.puts).toHaveLength(1);
    const item = writer.puts[0].Item;
    expect(item.PK).toBe('TENANT#tenant-abc');
    expect(item.tenantId).toBe('tenant-abc');
    expect(item.entityType).toBe('Failure');
    expect(item.SK.startsWith(`${NOTIFICATION_FAILURE_SK_PREFIX}sms#`)).toBe(true);
    expect(item.data).toMatchObject({
      kind: 'notification-delivery-failure',
      channel: 'sms',
      reason: 'sns down',
      outcome: 'error',
    });
  });
});
