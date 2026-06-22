/**
 * ml/sentiment/handler — the ML-2 Sentiment Scorer Lambda entrypoint.
 *
 * This is the Lambda the ML-1 Kinesis ingest stream (task 19.1) triggers. The
 * handler's only job is to adapt each ingested record to the pure
 * {@link scoreAndPublish} domain logic and to provide a real CP-3 publisher so
 * the produced score rides `Call.sentiment` via `publishCallUpdate`
 * (R22.2 / R10.4).
 *
 * The event-source shape is modeled behind a minimal {@link KinesisLikeEvent}
 * interface rather than depending on the ML-1 pipeline's exact export (task 19.1
 * is concurrent): each record is a base64-encoded JSON {@link IngestedCallRecord}.
 * {@link parseRecords} decodes them and is unit-tested independently of AWS.
 *
 * _Requirements: 22.1, 22.2, 22.3, 10.4_
 */

import {
  AppSyncCallSentimentPublisher,
} from './appsync-publisher';
import {
  CallSentimentPublisher,
  IngestedCallRecord,
  SentimentScore,
  scoreAndPublish,
} from './sentiment-scoring';

/** Env var carrying the CP-3 AppSync GraphQL endpoint URL (wired by the stack). */
export const CP3_APPSYNC_URL_ENV = 'CP3_APPSYNC_URL';

/** Env var carrying the AppSync API region for SigV4 (wired by the stack). */
export const CP3_APPSYNC_REGION_ENV = 'CP3_APPSYNC_REGION';

/** A single Kinesis-style record (minimal shape ML-2 depends on). */
export interface KinesisLikeRecord {
  readonly kinesis: {
    /** Base64-encoded JSON {@link IngestedCallRecord}. */
    readonly data: string;
  };
}

/** A Kinesis-style batch event (minimal shape ML-2 depends on). */
export interface KinesisLikeEvent {
  readonly Records: ReadonlyArray<KinesisLikeRecord>;
}

/**
 * Decode a Kinesis-style batch into {@link IngestedCallRecord}s. Each record's
 * `kinesis.data` is base64-encoded JSON. Modeled independently of the ML-1
 * pipeline so the two tasks stay decoupled.
 */
export function parseRecords(event: KinesisLikeEvent): IngestedCallRecord[] {
  if (!event || !Array.isArray(event.Records)) {
    return [];
  }
  return event.Records.map((record) => {
    const json = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
    return JSON.parse(json) as IngestedCallRecord;
  });
}

/** Build the real CP-3 publisher from the Lambda's wired environment. */
function appSyncPublisher(): CallSentimentPublisher {
  const endpoint = process.env[CP3_APPSYNC_URL_ENV];
  const region =
    process.env[CP3_APPSYNC_REGION_ENV] ?? process.env.AWS_REGION ?? '';
  if (!endpoint) {
    throw new Error(
      `Sentiment scorer is not configured: ${CP3_APPSYNC_URL_ENV} is unset.`,
    );
  }
  return new AppSyncCallSentimentPublisher({ endpoint, region });
}

/**
 * The Lambda handler. Decodes the ingested batch, scores each Call, and
 * publishes each score onto `Call.sentiment` via CP-3. Returns the produced
 * scores so the invocation result reflects what was scored. The default
 * lexicon model is used until ML-4 wires a SageMaker-backed model in.
 */
export async function handler(
  event: KinesisLikeEvent,
): Promise<SentimentScore[]> {
  const publisher = appSyncPublisher();
  const records = parseRecords(event);

  const scores: SentimentScore[] = [];
  for (const record of records) {
    scores.push(await scoreAndPublish(record, { publisher }));
  }
  return scores;
}
