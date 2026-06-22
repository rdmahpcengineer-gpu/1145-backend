/**
 * ml/sentiment/sentiment-construct — the ML-2 Sentiment Scorer Lambda (design ML-2).
 *
 * Provisions the Lambda that consumes ingested call data, scores per-Call
 * sentiment scoped to `tenantId`, and publishes the score onto `Call.sentiment`
 * via the CP-3 `publishCallUpdate` fan-out mutation (Requirements 22.1, 22.2,
 * 22.3, 10.4). The scoring + publish logic lives in `ml/sentiment/**`
 * (`sentiment-scoring.ts` / `handler.ts`); this construct only wires it to AWS:
 *
 *  - Deploys the `ml/sentiment` handler as a Node 20 Lambda.
 *  - Passes the CP-3 AppSync endpoint + region via environment so the handler's
 *    IAM-signed publisher can invoke `publishCallUpdate`.
 *  - Grants the function `appsync:GraphQL` on exactly the `publishCallUpdate`
 *    mutation field (the `@aws_iam` publish path) — least privilege, no other
 *    mutation or query is granted.
 *  - Optionally attaches the ML-1 Kinesis ingest stream as an event source. The
 *    stream is OPTIONAL and injected, so this construct does not depend on the
 *    concurrent ML-1 work (task 19.1): when ML-1 lands its stream it can be
 *    passed in to complete the wiring without changing this construct.
 *
 * This module is self-contained so it can be instantiated from `MlStack` with a
 * single additive edit, alongside the concurrently-added ML-1/ML-4 constructs.
 */

import * as path from 'path';
import {
  Duration,
  Stack,
  aws_appsync as appsync,
  aws_kinesis as kinesis,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CP3_APPSYNC_REGION_ENV, CP3_APPSYNC_URL_ENV } from './handler';

/** The CP-3 mutation field this scorer is granted to invoke. */
const PUBLISH_CALL_UPDATE_FIELD = 'publishCallUpdate';

export interface SentimentScorerProps {
  /**
   * The CP-3 AppSync API the scorer publishes `Call.sentiment` to. The function
   * is granted IAM access to the `publishCallUpdate` mutation only, and receives
   * the GraphQL endpoint via environment.
   */
  readonly liveStateApi: appsync.GraphqlApi;

  /**
   * Optional ML-1 Kinesis ingest stream to consume. When omitted (the default
   * until task 19.1 lands its stream) the scorer is provisioned without an
   * event source so this construct stays decoupled from the concurrent ML-1
   * work; the stream can be wired in later without changing the handler.
   */
  readonly ingestStream?: kinesis.IStream;

  /**
   * Starting position for the Kinesis event source when {@link ingestStream} is
   * provided.
   * @default lambda.StartingPosition.LATEST
   */
  readonly startingPosition?: lambda.StartingPosition;
}

export class SentimentScorer extends Construct {
  /** The ML-2 Sentiment Scorer Lambda. */
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: SentimentScorerProps) {
    super(scope, id);

    this.function = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      timeout: Duration.seconds(30),
      description:
        'ML-2 Sentiment Scorer — scores per-Call sentiment and publishes Call.sentiment via CP-3',
      code: lambda.Code.fromAsset(path.join(__dirname)),
      environment: {
        [CP3_APPSYNC_URL_ENV]: props.liveStateApi.graphqlUrl,
        [CP3_APPSYNC_REGION_ENV]: Stack.of(this).region,
      },
    });

    // Least-privilege CP-3 access: only the publishCallUpdate mutation field,
    // matching the @aws_iam publish path (design "CP-3 — Publish resolvers").
    props.liveStateApi.grantMutation(this.function, PUBLISH_CALL_UPDATE_FIELD);

    // Optional ML-1 event source — kept light per task scope; wired only when a
    // stream is injected so this construct does not depend on task 19.1.
    if (props.ingestStream) {
      this.function.addEventSource(
        new eventSources.KinesisEventSource(props.ingestStream, {
          startingPosition:
            props.startingPosition ?? lambda.StartingPosition.LATEST,
        }),
      );
    }
  }
}
