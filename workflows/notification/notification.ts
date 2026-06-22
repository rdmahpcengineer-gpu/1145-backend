/**
 * workflows/notification/notification — the WF-4/5 Notification Service domain
 * logic (design WF-4/5).
 *
 * Pure, cloud-decoupled notification logic behind Requirement 16:
 *
 *   - **R16.1 — email confirmation.** On a confirmed booking/order, an email
 *     confirmation is sent via SES. SES is reached through the injectable
 *     {@link EmailSender} seam, so the domain logic runs in tests without AWS.
 *   - **R16.2 — conditional SMS (design Property 19).** An SMS confirmation is
 *     sent via SNS/Pinpoint **if and only if** the action carries an
 *     SMS-capable contact ({@link isSmsCapable}). SNS is reached through the
 *     injectable {@link SmsSender} seam.
 *   - **R16.3 — tenant scoping.** Content and recipients are scoped to the
 *     action's `tenantId`. The `tenantId` arrives already derived from a
 *     Validated_Session (the WF-1 orchestrator propagates it into every state
 *     input — design Property 7); this module never re-derives it from the
 *     client payload, and it never reads a recipient from anywhere but the
 *     action's own contact.
 *   - **R16.4 — record delivery failures (design Property 16).** A failed
 *     delivery attempt is **caught, not thrown away**: each channel's outcome
 *     (success or failure) is captured on the returned {@link DeliveryResult},
 *     and every failure is also handed to the injectable
 *     {@link DeliveryFailureRecorder} so it is durably recorded. A delivery
 *     failure does NOT roll back the already-confirmed booking/order (design
 *     "Error Handling → Notification delivery failures").
 *
 * The function takes its collaborators by injection ({@link NotifyDeps}), so it
 * is exercised in tests with fake senders/recorder and zero AWS coupling.
 *
 * _Requirements: 16.1, 16.2, 16.3, 16.4_
 */

/** The kind of confirmation that triggered the notification. */
export type ConfirmationType = 'booking' | 'order';

/** The notification channels the service can deliver on. */
export type NotificationChannel = 'email' | 'sms';

/**
 * A contact for a confirmation. `email` is the SES recipient; `phone` is the
 * SNS/Pinpoint recipient. A contact is "SMS-capable" only when it carries a
 * usable phone number and is not explicitly opted out (`smsCapable === false`).
 */
export interface Contact {
  /** Email recipient for the SES confirmation, when present. */
  readonly email?: string;
  /** E.164 phone number for the SMS confirmation, when present. */
  readonly phone?: string;
  /** Explicit opt-out flag; when `false` no SMS is sent even with a phone. */
  readonly smsCapable?: boolean;
  /** Remaining contact payload (name …) passed through untouched. */
  readonly [key: string]: unknown;
}

/** A normalized, tenant-scoped confirmation handed to the service. */
export interface Confirmation {
  /** Whether this confirms a booking or an order. */
  readonly type: ConfirmationType;
  /** Caller-facing reference id of the booking/order being confirmed. */
  readonly referenceId?: string;
  /** Human-readable summary line included in the message body. */
  readonly summary?: string;
  /** Remaining confirmation payload passed through untouched. */
  readonly [key: string]: unknown;
}

/** A tenant-scoped notification request. */
export interface NotificationRequest {
  /** Operative tenant — derived from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** What is being confirmed. */
  readonly confirmation: Confirmation;
  /** Who to notify; scoped to this action's tenant. */
  readonly contact: Contact;
}

/** An email message scoped to a single tenant (the SES seam input). */
export interface EmailMessage {
  readonly tenantId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** An SMS message scoped to a single tenant (the SNS/Pinpoint seam input). */
export interface SmsMessage {
  readonly tenantId: string;
  readonly to: string;
  readonly body: string;
}

/** Injectable SES seam — implemented by a thin SDK adapter at runtime. */
export interface EmailSender {
  sendEmail(message: EmailMessage): Promise<void>;
}

/** Injectable SNS/Pinpoint seam — implemented by a thin SDK adapter at runtime. */
export interface SmsSender {
  sendSms(message: SmsMessage): Promise<void>;
}

/** A recorded delivery failure (R16.4 / design Property 16). */
export interface DeliveryFailure {
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  /** Why the attempt failed (no recipient, or the sender's error message). */
  readonly reason: string;
}

/**
 * Injectable sink for delivery failures. The handler wires this to a durable
 * tenant-scoped store; domain tests default it to a no-op so a failure is still
 * captured on the {@link DeliveryResult} without needing a backing store.
 */
export interface DeliveryFailureRecorder {
  record(failure: DeliveryFailure): Promise<void>;
}

/** Per-channel delivery outcome captured on the result (never discarded). */
export interface ChannelResult {
  readonly channel: NotificationChannel;
  /** Whether the channel was attempted (SMS is skipped without a contact). */
  readonly attempted: boolean;
  /** Whether the attempt delivered successfully. */
  readonly delivered: boolean;
  /** Failure reason when `attempted && !delivered`. */
  readonly reason?: string;
}

/** The result of a notification attempt (design WF-4/5: `DeliveryResult`). */
export interface DeliveryResult {
  /** The tenant the notification was scoped to. */
  readonly tenantId: string;
  /** Per-channel outcomes (email always present; sms present when attempted). */
  readonly channels: ReadonlyArray<ChannelResult>;
  /** True iff every ATTEMPTED channel delivered. */
  readonly allDelivered: boolean;
}

/** Collaborators injected into {@link notify}. */
export interface NotifyDeps {
  /** SES seam for the email confirmation. */
  readonly email: EmailSender;
  /** SNS/Pinpoint seam for the SMS confirmation. */
  readonly sms: SmsSender;
  /**
   * Sink for delivery failures (R16.4). Defaults to a no-op recorder; the
   * Lambda handler supplies a tenant-scoped durable recorder.
   */
  readonly failureRecorder?: DeliveryFailureRecorder;
}

/** Thrown when a notification request lacks the propagated tenant scope. */
export class NotificationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationScopeError';
    Object.setPrototypeOf(this, NotificationScopeError.prototype);
  }
}

/**
 * A contact is SMS-capable iff it carries a non-empty phone number and is not
 * explicitly opted out. This is the single predicate behind design Property 19
 * ("SMS is sent exactly when an SMS-capable contact exists").
 */
export function isSmsCapable(contact: Contact | undefined | null): boolean {
  if (!contact || typeof contact !== 'object') {
    return false;
  }
  const hasPhone =
    typeof contact.phone === 'string' && contact.phone.trim().length > 0;
  return hasPhone && contact.smsCapable !== false;
}

/** A no-op failure recorder; the captured {@link ChannelResult} still records it. */
const NOOP_RECORDER: DeliveryFailureRecorder = {
  async record(): Promise<void> {
    /* intentionally empty — failure is captured on the DeliveryResult */
  },
};

/** Build the tenant-scoped email subject/body for a confirmation. */
export function buildEmailMessage(
  request: NotificationRequest,
  to: string,
): EmailMessage {
  const { tenantId, confirmation } = request;
  const noun = confirmation.type === 'booking' ? 'Booking' : 'Order';
  const ref = confirmation.referenceId ? ` ${confirmation.referenceId}` : '';
  return {
    tenantId,
    to,
    subject: `${noun} confirmation${ref}`,
    body:
      confirmation.summary ??
      `Your ${confirmation.type}${ref} has been confirmed.`,
  };
}

/** Build the tenant-scoped SMS body for a confirmation. */
export function buildSmsMessage(
  request: NotificationRequest,
  to: string,
): SmsMessage {
  const { tenantId, confirmation } = request;
  const ref = confirmation.referenceId ? ` ${confirmation.referenceId}` : '';
  return {
    tenantId,
    to,
    body:
      confirmation.summary ??
      `Your ${confirmation.type}${ref} is confirmed.`,
  };
}

/**
 * Send notifications for a confirmed booking/order.
 *
 *  1. Validate the tenant scope (R16.3) — a missing tenant throws
 *     {@link NotificationScopeError} before anything is sent.
 *  2. Send an email confirmation via the SES seam (R16.1). A missing email
 *     recipient or a sender error is caught and recorded, not thrown.
 *  3. If (and only if) the contact is SMS-capable, send an SMS confirmation via
 *     the SNS/Pinpoint seam (R16.2 / design Property 19). Errors are caught and
 *     recorded.
 *  4. Return a {@link DeliveryResult} capturing each channel's success/failure;
 *     every failure is also handed to the {@link DeliveryFailureRecorder}
 *     (R16.4 / design Property 16). Delivery failures never roll back the
 *     already-confirmed booking/order.
 */
export async function notify(
  request: NotificationRequest,
  deps: NotifyDeps,
): Promise<DeliveryResult> {
  const { tenantId, contact } = request;

  // R16.3 — the orchestrator propagates a Validated_Session tenant into every
  // state input; defend against a missing one rather than silently mis-scoping.
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new NotificationScopeError(
      'Notification request is missing a tenantId (it must be propagated from the orchestrator).',
    );
  }

  const recorder = deps.failureRecorder ?? NOOP_RECORDER;
  const channels: ChannelResult[] = [];

  const recordFailure = async (
    channel: NotificationChannel,
    reason: string,
  ): Promise<ChannelResult> => {
    await recorder.record({ tenantId, channel, reason });
    return { channel, attempted: true, delivered: false, reason };
  };

  // --- Email channel (R16.1) — always attempted on a confirmation. --------
  const emailTo =
    typeof contact?.email === 'string' && contact.email.trim().length > 0
      ? contact.email.trim()
      : undefined;
  if (!emailTo) {
    channels.push(await recordFailure('email', 'no email recipient on contact'));
  } else {
    try {
      await deps.email.sendEmail(buildEmailMessage(request, emailTo));
      channels.push({ channel: 'email', attempted: true, delivered: true });
    } catch (err) {
      channels.push(await recordFailure('email', errorReason(err)));
    }
  }

  // --- SMS channel (R16.2 / Property 19) — iff an SMS-capable contact. -----
  if (isSmsCapable(contact)) {
    const smsTo = (contact.phone as string).trim();
    try {
      await deps.sms.sendSms(buildSmsMessage(request, smsTo));
      channels.push({ channel: 'sms', attempted: true, delivered: true });
    } catch (err) {
      channels.push(await recordFailure('sms', errorReason(err)));
    }
  } else {
    // Not attempted — recorded so the result is explicit, but it is not a
    // failure (no SMS was due).
    channels.push({ channel: 'sms', attempted: false, delivered: false });
  }

  const allDelivered = channels
    .filter((c) => c.attempted)
    .every((c) => c.delivered);

  return { tenantId, channels, allDelivered };
}

/** Extract a human-readable reason from an unknown thrown value. */
function errorReason(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : 'unknown delivery error';
}
