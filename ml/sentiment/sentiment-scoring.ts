/**
 * ml/sentiment/sentiment-scoring — the ML-2 Sentiment Scorer domain logic (design ML-2).
 *
 * Pure, cloud-decoupled sentiment logic behind Requirement 22 and Requirement
 * 10.4:
 *
 *   - **R22.1 — produce a per-Call score.** Given an ingested call record, the
 *     scorer produces a sentiment score for the Call. Scoring is delegated to an
 *     injected {@link SentimentModel} seam so a real SageMaker-backed model
 *     (ML-4) can be dropped in without touching this logic; a deterministic
 *     {@link defaultSentimentModel} keeps the Lambda useful end-to-end until
 *     then.
 *   - **R22.2 / R10.4 — the score rides `Call.sentiment`.** The produced score is
 *     published onto the `Call.sentiment` field via the CP-3 `publishCallUpdate`
 *     fan-out mutation (design ML-2; design Property 14). The CP-3 publish is an
 *     injected {@link CallSentimentPublisher} seam so this module is unit-tested
 *     with a fake publisher and zero AWS coupling.
 *   - **R22.3 — tenant scoping.** Each scored Call is scoped to its `tenantId`.
 *     The tenant is taken from the ingested record, which ML-1 tagged from the
 *     validated SE-1 session (design ML-1: "every record is tagged with
 *     `tenantId`"); this module never re-derives it from an arbitrary field. A
 *     record without a valid tenant is rejected before any publish, mirroring the
 *     platform rule that a tenant always originates from a validated session
 *     (multi-tenant isolation rule 3; design Property 2).
 *
 * The function takes its collaborators by injection ({@link ScoreAndPublishDeps}),
 * so it is exercised in tests with a fake model + publisher.
 *
 * _Requirements: 22.1, 22.2, 22.3, 10.4_
 */

import { assertValidTenantId } from '../../data/crypto/tenant_key';

/** The lower/upper bounds of a normalized sentiment score. */
export const SENTIMENT_MIN = -1;
export const SENTIMENT_MAX = 1;

/**
 * A single ingested call record the scorer consumes. This is modeled
 * independently of the ML-1 Kinesis pipeline's exact record shape (task 19.1):
 * ML-2 only depends on the fields it needs — the owning `tenantId`, the `callId`
 * the score attaches to, and the `text` to score — so the two tasks can evolve
 * without coupling. Additional ingest fields are carried but ignored here.
 */
export interface IngestedCallRecord {
  /** Owning tenant — tagged by ML-1 from the validated SE-1 session. */
  readonly tenantId: string;
  /** The Call this turn belongs to; the score attaches to this Call. */
  readonly callId: string;
  /** The utterance text to score. */
  readonly text: string;
  /** Optional speaker label (e.g. `caller` / `agent`). */
  readonly speaker?: string;
  /** Optional 1-based turn index. */
  readonly turn?: number;
  /** Remaining ingest payload, carried opaquely. */
  readonly [key: string]: unknown;
}

/** A produced sentiment score for a Call, scoped to its tenant (R22.1/R22.3). */
export interface SentimentScore {
  readonly tenantId: string;
  readonly callId: string;
  /** Normalized sentiment in `[-1, 1]`; negative = unhappy, positive = happy. */
  readonly score: number;
}

/**
 * The `Call`-shaped payload published onto CP-3 `publishCallUpdate`. The score
 * rides the `sentiment` field (R22.2 / R10.4 / design Property 14). The `id` is
 * the Call id (matching the imported SDL `CallInput.id`); `tenantId` is the
 * authoritative tenant the CP-3 IAM publish resolver re-asserts onto the
 * fanned-out payload.
 */
export interface CallSentimentUpdate {
  readonly id: string;
  readonly tenantId: string;
  readonly sentiment: number;
}

/**
 * The scoring seam (R22.1). A real implementation calls a SageMaker-hosted
 * model (ML-4); the default is a lightweight lexicon heuristic. Implementations
 * return a raw score that {@link scoreAndPublish} clamps into `[-1, 1]`.
 */
export interface SentimentModel {
  score(input: SentimentModelInput): number | Promise<number>;
}

/** The input handed to a {@link SentimentModel}. */
export interface SentimentModelInput {
  readonly text: string;
  readonly callId: string;
  readonly tenantId: string;
}

/**
 * The CP-3 publish seam (R22.2 / R10.4). Mirrors the AgentCore `TurnPublisher`
 * surface: the backend invokes `publishCallUpdate` with the tenant set from the
 * validated session, and the no-op fan-out resolver delivers it to subscribers
 * (design "CP-3 — Publish resolvers"; design Property 6). No persistent write
 * occurs as a result.
 */
export interface CallSentimentPublisher {
  publishCallUpdate(
    tenantId: string,
    call: CallSentimentUpdate,
  ): void | Promise<void>;
}

/** Thrown when an ingested record cannot be scored (missing tenant/call/text). */
export class SentimentScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentimentScoringError';
    Object.setPrototypeOf(this, SentimentScoringError.prototype);
  }
}

/** Collaborators injected into {@link scoreAndPublish}. */
export interface ScoreAndPublishDeps {
  /** The sentiment model (R22.1 seam); defaults to {@link defaultSentimentModel}. */
  readonly model?: SentimentModel;
  /** The CP-3 publish surface (R22.2/R10.4 seam). */
  readonly publisher: CallSentimentPublisher;
}

/** Clamp a raw model score into the normalized `[-1, 1]` band. */
export function clampScore(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new SentimentScoringError(
      `Sentiment model produced a non-finite score: ${raw}.`,
    );
  }
  return Math.min(SENTIMENT_MAX, Math.max(SENTIMENT_MIN, raw));
}

/**
 * Score one ingested Call record and publish the score onto `Call.sentiment`.
 *
 *  1. Validate the record carries a valid `tenantId` (from ML-1 / the validated
 *     SE-1 session), a `callId`, and `text`. A missing/invalid tenant is
 *     rejected BEFORE any scoring or publish (R22.3 / design Property 2).
 *  2. Produce a score via the injected model and clamp it to `[-1, 1]` (R22.1).
 *  3. Publish a `Call`-shaped payload carrying the score on `sentiment` via the
 *     CP-3 `publishCallUpdate` seam, with the tenant set from the validated
 *     record (R22.2, R10.4 / design Property 14).
 *
 * Returns the produced {@link SentimentScore} so callers (the Lambda handler)
 * can surface it.
 */
export async function scoreAndPublish(
  record: IngestedCallRecord,
  deps: ScoreAndPublishDeps,
): Promise<SentimentScore> {
  // R22.3 / Property 2 — the tenant must originate from the validated session
  // (ML-1 tagged it onto the record). Reject anything else before scoring.
  assertValidTenantId(record?.tenantId);
  const { tenantId } = record;

  if (typeof record.callId !== 'string' || record.callId.length === 0) {
    throw new SentimentScoringError(
      'Ingested record is missing a callId to attach the sentiment score to.',
    );
  }
  if (typeof record.text !== 'string') {
    throw new SentimentScoringError(
      'Ingested record is missing utterance text to score.',
    );
  }

  // R22.1 — produce the per-Call score via the injected model seam.
  const model = deps.model ?? defaultSentimentModel;
  const raw = await model.score({
    text: record.text,
    callId: record.callId,
    tenantId,
  });
  const score = clampScore(raw);

  // R22.2 / R10.4 / Property 14 — the score rides Call.sentiment, published via
  // CP-3 publishCallUpdate with the tenant set from the validated record.
  const update: CallSentimentUpdate = {
    id: record.callId,
    tenantId,
    sentiment: score,
  };
  await deps.publisher.publishCallUpdate(tenantId, update);

  return { tenantId, callId: record.callId, score };
}

/**
 * A deterministic, dependency-free lexicon heuristic used until the ML-4
 * SageMaker model is wired in. It counts positive/negative cue words and
 * normalizes the net signal into `[-1, 1]`. It is intentionally simple — its
 * only contract is "produce a finite score for any text" so the end-to-end
 * publish path works; ML-4 replaces it with a trained model.
 */
export const defaultSentimentModel: SentimentModel = {
  score({ text }: SentimentModelInput): number {
    const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
    if (tokens.length === 0) {
      return 0;
    }
    let net = 0;
    for (const token of tokens) {
      if (POSITIVE_CUES.has(token)) {
        net += 1;
      } else if (NEGATIVE_CUES.has(token)) {
        net -= 1;
      }
    }
    if (net === 0) {
      return 0;
    }
    // Normalize by a soft saturation so a few strong cues approach but never
    // exceed the bounds; clampScore is the hard guarantee.
    return Math.tanh(net / 3);
  },
};

/** Minimal positive-cue lexicon for the default heuristic model. */
const POSITIVE_CUES: ReadonlySet<string> = new Set([
  'thanks',
  'thank',
  'great',
  'good',
  'perfect',
  'happy',
  'love',
  'excellent',
  'awesome',
  'appreciate',
  'wonderful',
  'pleased',
]);

/** Minimal negative-cue lexicon for the default heuristic model. */
const NEGATIVE_CUES: ReadonlySet<string> = new Set([
  'angry',
  'bad',
  'terrible',
  'awful',
  'hate',
  'frustrated',
  'frustrating',
  'upset',
  'disappointed',
  'worst',
  'broken',
  'unacceptable',
]);
