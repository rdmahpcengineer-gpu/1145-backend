/**
 * Unit / example tests for the WF-4/5 Notification Service domain logic (task 17.1).
 *
 * Covers Requirement 16:
 *  - 16.1 an email confirmation is sent via the SES seam on a confirmation
 *  - 16.2 an SMS confirmation is sent via the SNS seam iff an SMS-capable
 *         contact is present (design Property 19)
 *  - 16.3 content and recipients are scoped to the action's tenantId
 *  - 16.4 a failed delivery attempt is recorded (captured on the result AND
 *         handed to the failure recorder), and does not throw / roll back
 */

import {
  Contact,
  DeliveryFailure,
  EmailMessage,
  NotificationScopeError,
  SmsMessage,
  buildEmailMessage,
  buildSmsMessage,
  isSmsCapable,
  notify,
} from './notification';

/** Records each email/sms sent so tests can assert on what was delivered. */
class RecordingEmailSender {
  readonly sent: EmailMessage[] = [];
  fail = false;
  async sendEmail(message: EmailMessage): Promise<void> {
    if (this.fail) throw new Error('ses unavailable');
    this.sent.push(message);
  }
}

class RecordingSmsSender {
  readonly sent: SmsMessage[] = [];
  fail = false;
  async sendSms(message: SmsMessage): Promise<void> {
    if (this.fail) throw new Error('sns unavailable');
    this.sent.push(message);
  }
}

class RecordingFailureSink {
  readonly failures: DeliveryFailure[] = [];
  async record(failure: DeliveryFailure): Promise<void> {
    this.failures.push(failure);
  }
}

const bookingConfirmation = {
  type: 'booking' as const,
  referenceId: 'bk-1',
  summary: 'Your booking bk-1 is confirmed for 2pm.',
};

describe('notify', () => {
  it('sends an email confirmation via SES on a confirmation (R16.1)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    const result = await notify(
      {
        tenantId: 'tenant-abc',
        confirmation: bookingConfirmation,
        contact: { email: 'caller@example.com' },
      },
      { email, sms },
    );

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('caller@example.com');
    expect(email.sent[0].tenantId).toBe('tenant-abc');
    expect(result.allDelivered).toBe(true);
    const emailChannel = result.channels.find((c) => c.channel === 'email');
    expect(emailChannel).toMatchObject({ attempted: true, delivered: true });
  });

  it('sends an SMS when an SMS-capable contact is present (R16.2 / Property 19)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    await notify(
      {
        tenantId: 't1',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com', phone: '+15551234567' },
      },
      { email, sms },
    );

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe('+15551234567');
    expect(sms.sent[0].tenantId).toBe('t1');
  });

  it('does NOT send an SMS when no SMS-capable contact is present (R16.2 / Property 19)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    const result = await notify(
      {
        tenantId: 't1',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com' }, // no phone
      },
      { email, sms },
    );

    expect(sms.sent).toHaveLength(0);
    const smsChannel = result.channels.find((c) => c.channel === 'sms');
    expect(smsChannel).toMatchObject({ attempted: false, delivered: false });
  });

  it('does NOT send an SMS when the contact opted out of SMS', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    await notify(
      {
        tenantId: 't1',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com', phone: '+15551234567', smsCapable: false },
      },
      { email, sms },
    );
    expect(sms.sent).toHaveLength(0);
  });

  it('scopes content and recipients to the action tenant (R16.3)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    await notify(
      {
        tenantId: 'tenant-real',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com', phone: '+15550000000' },
      },
      { email, sms },
    );
    expect(email.sent[0].tenantId).toBe('tenant-real');
    expect(sms.sent[0].tenantId).toBe('tenant-real');
  });

  it('records an email delivery failure without throwing (R16.4)', async () => {
    const email = new RecordingEmailSender();
    email.fail = true;
    const sms = new RecordingSmsSender();
    const failureRecorder = new RecordingFailureSink();

    const result = await notify(
      {
        tenantId: 't1',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com', phone: '+15551234567' },
      },
      { email, sms, failureRecorder },
    );

    // The SMS still went out; the email failure was captured, not thrown.
    expect(sms.sent).toHaveLength(1);
    expect(result.allDelivered).toBe(false);
    const emailChannel = result.channels.find((c) => c.channel === 'email');
    expect(emailChannel).toMatchObject({ attempted: true, delivered: false });
    expect(emailChannel?.reason).toContain('ses unavailable');
    // R16.4 — the failure was also durably recorded.
    expect(failureRecorder.failures).toEqual([
      { tenantId: 't1', channel: 'email', reason: 'ses unavailable' },
    ]);
  });

  it('records an SMS delivery failure without rolling back the email (R16.4)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    sms.fail = true;
    const failureRecorder = new RecordingFailureSink();

    const result = await notify(
      {
        tenantId: 't1',
        confirmation: bookingConfirmation,
        contact: { email: 'c@example.com', phone: '+15551234567' },
      },
      { email, sms, failureRecorder },
    );

    expect(email.sent).toHaveLength(1); // email confirmed, not rolled back
    expect(result.allDelivered).toBe(false);
    expect(failureRecorder.failures).toEqual([
      { tenantId: 't1', channel: 'sms', reason: 'sns unavailable' },
    ]);
  });

  it('records a missing-recipient email failure', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    const failureRecorder = new RecordingFailureSink();
    const result = await notify(
      { tenantId: 't1', confirmation: bookingConfirmation, contact: {} },
      { email, sms, failureRecorder },
    );
    expect(email.sent).toHaveLength(0);
    expect(result.allDelivered).toBe(false);
    expect(failureRecorder.failures[0]).toMatchObject({ channel: 'email' });
  });

  it('rejects a request with no tenant scope before sending anything (R16.3)', async () => {
    const email = new RecordingEmailSender();
    const sms = new RecordingSmsSender();
    await expect(
      notify(
        { tenantId: '', confirmation: bookingConfirmation, contact: { email: 'c@e.com' } },
        { email, sms },
      ),
    ).rejects.toBeInstanceOf(NotificationScopeError);
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
  });
});

describe('isSmsCapable', () => {
  it('is true for a non-empty phone not opted out', () => {
    expect(isSmsCapable({ phone: '+15551234567' })).toBe(true);
    expect(isSmsCapable({ phone: '+15551234567', smsCapable: true })).toBe(true);
  });
  it('is false without a phone', () => {
    expect(isSmsCapable({ email: 'c@e.com' })).toBe(false);
    expect(isSmsCapable({ phone: '   ' })).toBe(false);
  });
  it('is false when opted out', () => {
    expect(isSmsCapable({ phone: '+15551234567', smsCapable: false })).toBe(false);
  });
  it('is false for a missing contact', () => {
    expect(isSmsCapable(undefined)).toBe(false);
    expect(isSmsCapable(null)).toBe(false);
  });
});

describe('message builders', () => {
  it('builds a tenant-scoped email subject/body', () => {
    const msg = buildEmailMessage(
      { tenantId: 't1', confirmation: bookingConfirmation, contact: {} as Contact },
      'c@e.com',
    );
    expect(msg).toMatchObject({ tenantId: 't1', to: 'c@e.com' });
    expect(msg.subject).toContain('Booking');
    expect(msg.body).toBe(bookingConfirmation.summary);
  });

  it('falls back to a default body when no summary is given', () => {
    const msg = buildSmsMessage(
      {
        tenantId: 't1',
        confirmation: { type: 'order', referenceId: 'o-9' },
        contact: {} as Contact,
      },
      '+15550000000',
    );
    expect(msg.body).toContain('order');
    expect(msg.body).toContain('o-9');
  });
});
