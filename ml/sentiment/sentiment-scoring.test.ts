/**
 * Unit tests for the ML-2 Sentiment Scorer domain logic (task 20.1).
 *
 * Example-based coverage of: a per-Call score is produced (R22.1); the score
 * rides `Call.sentiment` on the published payload (R22.2 / R10.4); the publish
 * is scoped to the record's tenant (R22.3); records without a valid tenant are
 * rejected before any publish (multi-tenant isolation; design Property 2); and
 * scores are clamped into `[-1, 1]`.
 */

import {
  CallSentimentPublisher,
  CallSentimentUpdate,
  IngestedCallRecord,
  SENTIMENT_MAX,
  SENTIMENT_MIN,
  SentimentModel,
  SentimentScoringError,
  clampScore,
  defaultSentimentModel,
  scoreAndPublish,
} from './sentiment-scoring';

/** Captures publishCallUpdate invocations for assertions. */
class RecordingPublisher implements CallSentimentPublisher {
  readonly calls: Array<{ tenantId: string; call: CallSentimentUpdate }> = [];

  publishCallUpdate(tenantId: string, call: CallSentimentUpdate): void {
    this.calls.push({ tenantId, call });
  }
}

/** A fixed-score model so assertions are deterministic. */
function fixedModel(score: number): SentimentModel {
  return { score: () => score };
}

const TENANT = 'tenant-abc';
const CALL = 'call-123';

function record(overrides: Partial<IngestedCallRecord> = {}): IngestedCallRecord {
  return {
    tenantId: TENANT,
    callId: CALL,
    text: 'thanks so much, this was great',
    ...overrides,
  };
}

describe('scoreAndPublish', () => {
  it('produces a per-Call score and returns it (R22.1)', async () => {
    const publisher = new RecordingPublisher();
    const result = await scoreAndPublish(record(), {
      model: fixedModel(0.5),
      publisher,
    });

    expect(result).toEqual({ tenantId: TENANT, callId: CALL, score: 0.5 });
  });

  it('publishes the score onto Call.sentiment via publishCallUpdate (R22.2 / R10.4)', async () => {
    const publisher = new RecordingPublisher();
    await scoreAndPublish(record(), { model: fixedModel(0.42), publisher });

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].call).toEqual({
      id: CALL,
      tenantId: TENANT,
      sentiment: 0.42,
    });
  });

  it('scopes the published Call to the record tenant (R22.3)', async () => {
    const publisher = new RecordingPublisher();
    await scoreAndPublish(record({ tenantId: 'tenant-xyz' }), {
      model: fixedModel(0),
      publisher,
    });

    expect(publisher.calls[0].tenantId).toBe('tenant-xyz');
    expect(publisher.calls[0].call.tenantId).toBe('tenant-xyz');
  });

  it('clamps an over-range model score into [-1, 1]', async () => {
    const publisher = new RecordingPublisher();
    const hi = await scoreAndPublish(record(), { model: fixedModel(9), publisher });
    const lo = await scoreAndPublish(record(), { model: fixedModel(-9), publisher });

    expect(hi.score).toBe(SENTIMENT_MAX);
    expect(lo.score).toBe(SENTIMENT_MIN);
  });

  it('rejects a record with no tenant before publishing (Property 2)', async () => {
    const publisher = new RecordingPublisher();
    await expect(
      scoreAndPublish(record({ tenantId: '' }), {
        model: fixedModel(1),
        publisher,
      }),
    ).rejects.toThrow();
    expect(publisher.calls).toHaveLength(0);
  });

  it('rejects a record missing a callId before publishing', async () => {
    const publisher = new RecordingPublisher();
    await expect(
      scoreAndPublish(record({ callId: '' }), {
        model: fixedModel(1),
        publisher,
      }),
    ).rejects.toThrow(SentimentScoringError);
    expect(publisher.calls).toHaveLength(0);
  });

  it('rejects a non-finite model score', async () => {
    const publisher = new RecordingPublisher();
    await expect(
      scoreAndPublish(record(), { model: fixedModel(NaN), publisher }),
    ).rejects.toThrow(SentimentScoringError);
    expect(publisher.calls).toHaveLength(0);
  });

  it('uses the default lexicon model when none is injected', async () => {
    const publisher = new RecordingPublisher();
    const result = await scoreAndPublish(record(), { publisher });
    // "thanks ... great" → positive net signal.
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('defaultSentimentModel', () => {
  it('scores positive cue words above zero', () => {
    expect(
      defaultSentimentModel.score({
        text: 'thank you, excellent and perfect',
        callId: CALL,
        tenantId: TENANT,
      }),
    ).toBeGreaterThan(0);
  });

  it('scores negative cue words below zero', () => {
    expect(
      defaultSentimentModel.score({
        text: 'this is terrible and I am frustrated',
        callId: CALL,
        tenantId: TENANT,
      }),
    ).toBeLessThan(0);
  });

  it('scores neutral / empty text at zero', () => {
    expect(
      defaultSentimentModel.score({ text: '', callId: CALL, tenantId: TENANT }),
    ).toBe(0);
    expect(
      defaultSentimentModel.score({
        text: 'i would like to book an appointment',
        callId: CALL,
        tenantId: TENANT,
      }),
    ).toBe(0);
  });

  it('always stays within [-1, 1] even for many cues', () => {
    const score = defaultSentimentModel.score({
      text: 'great great great great great great great',
      callId: CALL,
      tenantId: TENANT,
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(SENTIMENT_MAX);
  });
});

describe('clampScore', () => {
  it('passes through in-range values', () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(0.3)).toBe(0.3);
    expect(clampScore(-0.7)).toBe(-0.7);
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampScore(5)).toBe(SENTIMENT_MAX);
    expect(clampScore(-5)).toBe(SENTIMENT_MIN);
  });

  it('throws on a non-finite value', () => {
    expect(() => clampScore(Infinity)).toThrow(SentimentScoringError);
    expect(() => clampScore(NaN)).toThrow(SentimentScoringError);
  });
});
