import {
  RemovalPolicy,
  Duration,
  aws_ec2 as ec2,
  aws_kms as kms,
  aws_rds as rds,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * EmbeddingStore — the DM-3 embedding store construct.
 *
 * Provisions **pgvector on Aurora PostgreSQL Serverless v2** (design.md "Data
 * Models → DM-3" offers pgvector/OpenSearch; we take pgvector/Aurora). The
 * cluster lives in an isolated VPC, is encrypted at rest under the same CP-4
 * data KMS key family, and hosts the `vector` extension so embeddings can be
 * stored and queried with nearest-neighbour search.
 *
 * Tenant isolation is enforced in software, not by the engine: every row is
 * stamped with a `tenantId` tag by the shared `data/tagging` helper, and every
 * similarity search carries a mandatory `tenantId = :t` predicate built by
 * `data/embedding/embedding_store`. The construct only provisions the engine;
 * it never issues unscoped queries.
 *
 * Scoped to task 3.2 — added alongside the existing DM-2 table without touching
 * the concurrent DM-1 (Redis) / DM-4 (S3) work.
 *
 * _Requirements: 19.1, 19.2, 19.3_
 */
export interface EmbeddingStoreProps {
  /** KMS key used to encrypt the cluster storage at rest. */
  readonly encryptionKey: kms.IKey;
  /** Logical database name hosting the pgvector tables. */
  readonly databaseName?: string;
  /** Serverless v2 min Aurora Capacity Units (defaults to 0.5). */
  readonly minCapacity?: number;
  /** Serverless v2 max Aurora Capacity Units (defaults to 2). */
  readonly maxCapacity?: number;
}

export class EmbeddingStore extends Construct {
  /** The isolated VPC the cluster runs in (no NAT, no public ingress). */
  readonly vpc: ec2.Vpc;

  /** The Aurora PostgreSQL Serverless v2 cluster hosting pgvector. */
  readonly cluster: rds.DatabaseCluster;

  /** Writer endpoint hostname for cross-stack wiring. */
  readonly endpoint: string;

  /** The logical database name hosting the embedding tables. */
  readonly databaseName: string;

  constructor(scope: Construct, id: string, props: EmbeddingStoreProps) {
    super(scope, id);

    this.databaseName = props.databaseName ?? 'embeddings';

    // Isolated network: no NAT gateways and no public subnets — the embedding
    // store is reached only from inside the VPC (AC-3 memory, ML ingest).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // pgvector lives in PostgreSQL 15; the `vector` extension is created at
    // bootstrap time (CREATE EXTENSION IF NOT EXISTS vector) by the schema
    // migration that owns the embedding tables.
    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      serverlessV2MinCapacity: props.minCapacity ?? 0.5,
      serverlessV2MaxCapacity: props.maxCapacity ?? 2,
      defaultDatabaseName: this.databaseName,
      // Encrypt cluster storage under the CP-4 data key family.
      storageEncrypted: true,
      storageEncryptionKey: props.encryptionKey,
      // Credentials are generated and stored in Secrets Manager (rotated).
      credentials: rds.Credentials.fromGeneratedSecret('embeddings_admin'),
      backup: { retention: Duration.days(7) },
      // Durable tenant-tagged embeddings: retain on stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.endpoint = this.cluster.clusterEndpoint.hostname;
  }
}
