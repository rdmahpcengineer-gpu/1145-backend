import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DataStack } from '../data/data-stack';
import { ControlPlaneStack } from '../control-plane/control-plane-stack';
import { SentimentScorer } from './sentiment/sentiment-construct';
import { SageMakerTrainingPipeline } from './training/sagemaker-pipeline-construct';
import { KinesisIngestStream } from './ingest/kinesis-ingest-construct';
import { ModelDeployerConstruct } from './deploy/model-deployer-construct';
import { publishWiring } from '../shared/wiring';

/**
 * MlStack — owns `ml/**` (ML-1/2/4/5).
 *
 * Filled in by later tasks:
 *  - 19.1 ML-1 Kinesis ingest
 *  - 20.1 ML-2 Sentiment scorer -> Call.sentiment via publishCallUpdate
 *  - 21.1 ML-4 SageMaker train/eval/registry pipeline
 *  - 21.2 ML-5 Model deployer (A2 approval hook)
 */
export interface MlStackProps extends StackProps {
  readonly dataStack: DataStack;
  readonly controlPlaneStack: ControlPlaneStack;
}

export class MlStack extends Stack {
  /** ML-1 Kinesis stream ingesting tenant-tagged call-turn data (task 19.1). */
  readonly ingestStream: KinesisIngestStream;

  /** ML-4 SageMaker train/eval/registry pipeline + model registry (task 21.1). */
  readonly trainingPipeline: SageMakerTrainingPipeline;

  /** ML-2 Sentiment Scorer — publishes Call.sentiment via CP-3 (task 20.1). */
  readonly sentimentScorer: SentimentScorer;

  /** ML-5 Model Deployer — promotes improved models to the AC_Runtime (task 21.2). */
  readonly modelDeployer: ModelDeployerConstruct;

  constructor(scope: Construct, id: string, props: MlStackProps) {
    super(scope, id, props);

    // --- ML-1 stream ingest (design.md "ML → ML-1" / Req 21) --------------
    //
    // Kinesis stream ingesting call-turn data. Tenant isolation is enforced in
    // software by the `ml/ingest/stream_ingest` producer: every record is
    // tagged with `tenantId` (reusing the shared `data/tagging` helper) and the
    // partition key includes the tenant. This construct only provisions the
    // stream + at-rest encryption. Added in its own module so it does not
    // collide with the concurrent ML-2 / ML-4 work in this stack.
    this.ingestStream = new KinesisIngestStream(this, 'IngestStream');
    // Export the stream name for the ML-2 sentiment consumer via shared wiring.
    publishWiring(this, 'ml/ingest-stream-name', this.ingestStream.streamName);

    // --- ML-4 train/eval/registry pipeline (design.md "ML → ML-4" / Req 23)
    //
    // SageMaker pipeline that trains, evaluates, and registers models; each run
    // records evaluation metrics and a version-identifying registry entry in
    // the model registry. The train→eval→register flow + registry-entry shape
    // live in `ml/training/**` (testable without live SageMaker); this construct
    // only provisions the pipeline + registry. Kept in its own module so it does
    // not collide with the concurrent ML-1 / ML-2 work in this stack.
    this.trainingPipeline = new SageMakerTrainingPipeline(
      this,
      'TrainingPipeline',
    );

    // --- ML-2 sentiment scoring (design.md "ML → ML-2" / Req 22, 10.4) ----
    //
    // Consumes ingested call data, produces a per-Call sentiment score scoped
    // to `tenantId`, and publishes the score onto `Call.sentiment` via the CP-3
    // `publishCallUpdate` fan-out mutation (tenant set from the validated
    // session). The scoring + publish logic lives in `ml/sentiment/**`; this
    // construct only wires the Lambda to CP-3 (least-privilege IAM grant on the
    // `publishCallUpdate` field). The ML-1 stream is wired in as an event source
    // separately, so the score logic stays decoupled from the concurrent ML-1
    // work; left unattached here to keep that wiring light.
    this.sentimentScorer = new SentimentScorer(this, 'SentimentScorer', {
      liveStateApi: props.controlPlaneStack.liveStateApi.api,
    });

    // --- ML-5 Model Deployer (design.md "ML → ML-5" / Req 24, assumption A2) -
    //
    // Compares a registered model's eval metrics to the currently deployed
    // model's and promotes the candidate IFF its metrics exceed the deployed
    // model's (Property 23); on a promote it updates the AC_Runtime's active
    // model version, otherwise it retains the deployed model (missing/
    // incomparable metrics fail safe to the status quo). Promotion is automatic
    // but gated by a configurable approval hook (default: auto-promote, A2). The
    // promote/retain logic lives in `ml/deploy/**` (testable without live
    // SageMaker/AgentCore); this construct only provisions the deployer Lambda
    // and the SSM parameter the AC_Runtime reads. Kept in its own module so it
    // does not collide with the concurrent ML-1/ML-2/ML-4 work in this stack.
    this.modelDeployer = new ModelDeployerConstruct(this, 'ModelDeployer');
  }
}
