/**
 * Unit tests for the ML-2 Sentiment Scorer Lambda handler glue (task 20.1).
 *
 * Covers the Kinesis-style record decoding (`parseRecords`) independently of
 * AWS — the scoring/publish logic itself is covered in sentiment-scoring.test.ts.
 */

import { IngestedCallRecord } from './sentiment-scoring';
import { KinesisLikeEvent, parseRecords } from './handler';

/** Base64-encode an ingested record as a Kinesis record would carry it. */
function kinesisRecord(payload: IngestedCallRecord) {
  return {
    kinesis: {
      data: Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64'),
    },
  };
}

describe('parseRecords', () => {
  it('decodes a batch of base64 JSON records', () => {
    const a: IngestedCallRecord = {
      tenantId: 't1',
      callId: 'c1',
      text: 'great',
    };
    const b: IngestedCallRecord = {
      tenantId: 't2',
      callId: 'c2',
      text: 'terrible',
    };
    const event: KinesisLikeEvent = {
      Records: [kinesisRecord(a), kinesisRecord(b)],
    };

    expect(parseRecords(event)).toEqual([a, b]);
  });

  it('returns an empty array for an event with no records', () => {
    expect(parseRecords({ Records: [] })).toEqual([]);
    expect(parseRecords(undefined as unknown as KinesisLikeEvent)).toEqual([]);
  });

  it('preserves extra ingest fields carried opaquely', () => {
    const payload = {
      tenantId: 't1',
      callId: 'c1',
      text: 'hello',
      speaker: 'caller',
      turn: 3,
      extra: { nested: true },
    } as unknown as IngestedCallRecord;

    expect(parseRecords({ Records: [kinesisRecord(payload)] })[0]).toEqual(
      payload,
    );
  });
});
