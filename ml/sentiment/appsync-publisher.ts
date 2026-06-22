/**
 * ml/sentiment/appsync-publisher — the real CP-3 publish transport for ML-2.
 *
 * A thin {@link CallSentimentPublisher} adapter that invokes the CP-3
 * `publishCallUpdate` fan-out mutation over the AppSync GraphQL HTTP endpoint,
 * authenticated with **AWS IAM (SigV4)** — matching the `@aws_iam` directive the
 * imported SDL carries on the `publish*` mutations (design "CP-3"). The tenant
 * is set on the `call` argument from the validated session (here, the tenant
 * tagged onto the ingested record by ML-1), which the CP-3 no-op fan-out
 * resolver re-asserts onto the delivered payload.
 *
 * Like the WF-2/WF-3 handler adapters, this loads the AWS SDK v3 signing modules
 * lazily via `require` so importing this file (e.g. in unit tests) carries no
 * compile-time dependency on the SDK; the modules are provided by the Node 20
 * Lambda runtime. The pure scoring + publish-decision logic lives in
 * `sentiment-scoring.ts` and is tested against a fake publisher — this transport
 * is intentionally minimal.
 *
 * _Requirements: 22.2, 10.3, 10.4_
 */

import { CallSentimentPublisher, CallSentimentUpdate } from './sentiment-scoring';

/** The `publishCallUpdate` mutation document (field/arg owned by the imported SDL). */
const PUBLISH_CALL_UPDATE_MUTATION = `mutation PublishCallUpdate($call: CallInput!) {
  publishCallUpdate(call: $call) {
    id
    tenantId
    sentiment
  }
}`;

/** Config for the {@link AppSyncCallSentimentPublisher}. */
export interface AppSyncPublisherConfig {
  /** The CP-3 AppSync GraphQL HTTP endpoint URL. */
  readonly endpoint: string;
  /** AWS region the AppSync API lives in (for SigV4). */
  readonly region: string;
}

/**
 * Publishes `Call.sentiment` to CP-3 via the IAM-authed `publishCallUpdate`
 * mutation. The execution role must be granted `appsync:GraphQL` on the
 * `publishCallUpdate` field (the {@link SentimentScorer} construct does this).
 */
export class AppSyncCallSentimentPublisher implements CallSentimentPublisher {
  constructor(private readonly config: AppSyncPublisherConfig) {
    if (!config.endpoint) {
      throw new Error('AppSyncCallSentimentPublisher requires an endpoint.');
    }
    if (!config.region) {
      throw new Error('AppSyncCallSentimentPublisher requires a region.');
    }
  }

  async publishCallUpdate(
    tenantId: string,
    call: CallSentimentUpdate,
  ): Promise<void> {
    const body = JSON.stringify({
      query: PUBLISH_CALL_UPDATE_MUTATION,
      // The tenant on the argument is the authoritative, session-derived tenant
      // the CP-3 IAM resolver stamps onto the fanned-out payload.
      variables: { call: { ...call, tenantId } },
    });

    const signed = await signRequest(this.config, body);

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: signed.headers,
      body,
    });

    if (!response.ok) {
      throw new Error(
        `CP-3 publishCallUpdate failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as { errors?: unknown[] };
    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `CP-3 publishCallUpdate returned errors: ${JSON.stringify(result.errors)}`,
      );
    }
  }
}

/**
 * SigV4-sign the AppSync POST. The AWS SDK v3 signing modules and the default
 * credential provider are loaded lazily (provided by the Node 20 Lambda
 * runtime), mirroring the lazy-require convention used by the WF handlers.
 */
async function signRequest(
  config: AppSyncPublisherConfig,
  body: string,
): Promise<{ headers: Record<string, string> }> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { SignatureV4 } = require('@aws-sdk/signature-v4');
  const { Sha256 } = require('@aws-crypto/sha256-js');
  const { defaultProvider } = require('@aws-sdk/credential-provider-node');
  const { HttpRequest } = require('@aws-sdk/protocol-http');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const url = new URL(config.endpoint);
  const request = new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      'content-type': 'application/json',
      host: url.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: config.region,
    service: 'appsync',
    sha256: Sha256,
  });

  const signed = await signer.sign(request);
  return { headers: signed.headers as Record<string, string> };
}
