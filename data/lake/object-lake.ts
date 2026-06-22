/**
 * data/lake/object-lake — DM-4 object-lake access module.
 *
 * The single choke point every audio/document write goes through. It enforces
 * the two DM-4 invariants in code, since neither can be expressed by an S3/IAM
 * primitive alone:
 *
 *   1. Tenant partitioning (R20.1, Property 20): every object key is built by
 *      `data/lake/keys` so it is prefixed by the owning tenant id.
 *   2. Tenant encryption (R20.3, Property 8): every put sets `SSEKMSKeyId` to
 *      the tenant's CP-4 key (resolved via `data/crypto/tenant_key` from the
 *      SAME `tenantId` used for the key prefix) plus the tenant encryption
 *      context, so an object is encrypted under exactly its tenant's key.
 *   3. The consent gate (A1, R20.2, Property 21): before ANY audio put,
 *      `storeAudio` consults the backend consent gate and FAILS CLOSED when
 *      consent for the caller's jurisdiction is absent/denied/ambiguous — no
 *      audio object is written. Documents (`storeDocument`) are not gated.
 *
 * The module depends on narrow interfaces (an {@link ObjectLakeWriter} and a
 * {@link ConsentReader}) rather than the AWS SDK directly, so it is fully
 * unit-testable and free of cloud coupling. At runtime, thin adapters over
 * `S3Client` and the DM-2 query builder are injected.
 *
 * _Requirements: 20.1, 20.2, 20.3_
 */

import {
  AwsContext,
  keyForTenant,
  encryptionContextForTenant,
} from '../crypto/tenant_key';
import {
  ConsentNotCapturedError,
} from './errors';
import {
  ConsentReader,
  evaluateConsent,
  isConsentGranted,
} from './consent';
import { documentKey, recordingKey } from './keys';

/** A narrow S3 PutObject input (decoupled from the AWS SDK). */
export interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: unknown;
  /** Always `'aws:kms'` for the object lake — SSE-KMS is mandatory. */
  ServerSideEncryption: 'aws:kms';
  /** The OWNING tenant's CP-4 key (alias ARN), resolved from the tenantId. */
  SSEKMSKeyId: string;
  ContentType?: string;
  /**
   * KMS encryption context binding the object to its tenant, so the data-plane
   * role can only use the tenant's key while operating in that tenant context.
   */
  encryptionContext?: Record<string, string>;
  /** Optional opaque metadata recorded on the object. */
  Metadata?: Record<string, string>;
}

/** Minimal S3 write surface (a runtime adapter wraps `S3Client`). */
export interface ObjectLakeWriter {
  putObject(input: PutObjectInput): Promise<unknown>;
}

/** Resolves the tenant's CP-4 key id used as `SSEKMSKeyId`. */
export type TenantKeyResolver = (tenantId: string) => string;

/** Result of a successful store. */
export interface StoredObject {
  /** The full S3 object key (tenant-prefixed). */
  readonly key: string;
  /** The CP-4 key id the object was encrypted under. */
  readonly sseKmsKeyId: string;
}

/** Inputs for {@link ObjectLake.storeAudio}. */
export interface StoreAudioInput {
  /** Operative tenant — from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** The Call this recording belongs to. */
  readonly callId: string;
  /** The caller's jurisdiction, used to look up captured consent. */
  readonly jurisdiction: string;
  /** Object name within `<tenantId>/recordings/<callId>/`. */
  readonly name: string;
  /** Audio bytes/stream. */
  readonly body: unknown;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

/** Inputs for {@link ObjectLake.storeDocument}. */
export interface StoreDocumentInput {
  /** Operative tenant — from a Validated_Session, never the client. */
  readonly tenantId: string;
  /** Object name within `<tenantId>/docs/`. */
  readonly name: string;
  /** Document bytes/stream. */
  readonly body: unknown;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

/** Options for constructing an {@link ObjectLake}. */
export interface ObjectLakeOptions {
  /** Reads the persisted `CONSENT#<callId>` record for the consent gate. */
  readonly consentReader: ConsentReader;
  /**
   * Resolves a tenant's CP-4 key id. Defaults to {@link keyForTenant}, which
   * derives the alias ARN from the tenantId (+ AWS context / environment).
   */
  readonly resolveTenantKey?: TenantKeyResolver;
  /** AWS placement passed to the default key resolver. */
  readonly awsContext?: AwsContext;
}

/**
 * Tenant-scoped access to the DM-4 object lake.
 */
export class ObjectLake {
  private readonly resolveTenantKey: TenantKeyResolver;
  private readonly consentReader: ConsentReader;

  constructor(
    private readonly bucketName: string,
    private readonly writer: ObjectLakeWriter,
    options: ObjectLakeOptions,
  ) {
    if (!bucketName) {
      throw new Error('ObjectLake requires a non-empty bucket name.');
    }
    if (!options?.consentReader) {
      throw new Error('ObjectLake requires a consentReader.');
    }
    this.consentReader = options.consentReader;
    this.resolveTenantKey =
      options.resolveTenantKey ??
      ((tenantId: string) => keyForTenant(tenantId, options.awsContext));
  }

  /**
   * Store Call audio AFTER the backend consent gate authorizes it.
   *
   * Order is significant: the consent check runs FIRST and throws
   * {@link ConsentNotCapturedError} (fail-closed) on any non-"granted"
   * decision, so the `putObject` is never reached when consent is absent,
   * denied, or ambiguous (Property 21).
   */
  async storeAudio(input: StoreAudioInput): Promise<StoredObject> {
    // 1. Consent gate (A1) — read the persisted record, fail closed.
    const record = await this.consentReader.read({
      tenantId: input.tenantId,
      callId: input.callId,
    });
    const decision = evaluateConsent(record, input.jurisdiction);
    if (!isConsentGranted(decision)) {
      throw new ConsentNotCapturedError(
        decision as 'absent' | 'denied' | 'ambiguous',
        input.callId,
        input.jurisdiction,
      );
    }

    // 2. Tenant-prefixed key + tenant-KMS-encrypted put.
    const key = recordingKey({
      tenantId: input.tenantId,
      callId: input.callId,
      name: input.name,
    });
    return this.put(input.tenantId, key, input.body, {
      contentType: input.contentType,
      metadata: input.metadata,
    });
  }

  /**
   * Store a tenant document. Documents are not consent-gated, but are still
   * tenant-prefixed and tenant-KMS-encrypted.
   */
  async storeDocument(input: StoreDocumentInput): Promise<StoredObject> {
    const key = documentKey({ tenantId: input.tenantId, name: input.name });
    return this.put(input.tenantId, key, input.body, {
      contentType: input.contentType,
      metadata: input.metadata,
    });
  }

  /** Build and issue the tenant-KMS-encrypted put for an already-built key. */
  private async put(
    tenantId: string,
    key: string,
    body: unknown,
    opts: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<StoredObject> {
    const sseKmsKeyId = this.resolveTenantKey(tenantId);
    const putInput: PutObjectInput = {
      Bucket: this.bucketName,
      Key: key,
      Body: body,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: sseKmsKeyId,
      encryptionContext: encryptionContextForTenant(tenantId),
    };
    if (opts.contentType !== undefined) putInput.ContentType = opts.contentType;
    if (opts.metadata !== undefined) putInput.Metadata = opts.metadata;

    await this.writer.putObject(putInput);
    return { key, sseKmsKeyId };
  }
}
