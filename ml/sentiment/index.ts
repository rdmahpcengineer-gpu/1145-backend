/**
 * ml/sentiment — ML-2 Sentiment Scorer.
 *
 * Public surface: the pure sentiment scoring + CP-3 publish domain logic
 * (design ML-2), the real AppSync publish transport, and the Lambda handler the
 * ML-1 Kinesis ingest stream triggers.
 */
export * from './sentiment-scoring';
export * from './appsync-publisher';
export * from './handler';
