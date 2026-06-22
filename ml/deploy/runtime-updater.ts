/**
 * ml/deploy/runtime-updater — the "apply promotion" side effect for ML-5.
 *
 * On a promote the deployer updates the AC_Runtime to use the promoted model
 * version (R24.2). The AgentCore runtime holds the active model version on its
 * `Session.model_version` (design.md "AC-1 — Runtime and session context"); the
 * runtime reads the active version from a well-known SSM parameter at
 * `CallStart`. This module models that update behind the injectable
 * {@link RuntimeModelUpdater} interface so the promotion logic is unit-testable
 * without a live runtime:
 *
 *  - {@link InMemoryRuntimeModelUpdater} — records the version in memory (tests).
 *  - {@link SsmParameterRuntimeUpdater}  — writes the active model version to the
 *    SSM parameter the AC_Runtime reads (production).
 *
 * _Requirements: 24.2_
 */

import { RuntimeModelUpdater } from './types';

/**
 * The SSM parameter holding the AC_Runtime's active reasoner model version. The
 * deployer writes the promoted version here; the AgentCore runtime reads it when
 * opening a session (seeding `Session.model_version`).
 */
export const ACTIVE_MODEL_VERSION_PARAM = '/1145/aws-backend/agent/active-model-version';

/**
 * In-memory updater for tests/local runs. Records the latest promoted version
 * and the full history so a test can assert the runtime was (or was not)
 * updated.
 */
export class InMemoryRuntimeModelUpdater implements RuntimeModelUpdater {
  private readonly versions: string[] = [];

  constructor(initialVersion?: string) {
    if (initialVersion !== undefined) {
      this.versions.push(initialVersion);
    }
  }

  updateModelVersion(modelVersion: string): void {
    this.versions.push(modelVersion);
  }

  /** The current (most recently applied) model version, or `undefined`. */
  get currentVersion(): string | undefined {
    return this.versions[this.versions.length - 1];
  }

  /** Every version applied, in order. */
  history(): readonly string[] {
    return [...this.versions];
  }
}

/** Config for {@link SsmParameterRuntimeUpdater}. */
export interface SsmParameterRuntimeUpdaterConfig {
  /** SSM parameter name to write. Defaults to {@link ACTIVE_MODEL_VERSION_PARAM}. */
  readonly parameterName?: string;
  /** AWS region the parameter lives in. Defaults to the Lambda's `AWS_REGION`. */
  readonly region?: string;
}

/**
 * Production updater: writes the promoted model version to the SSM parameter the
 * AC_Runtime reads. The AWS SDK v3 SSM client is loaded lazily via `require`
 * (provided by the Node 20 Lambda runtime), mirroring the lazy-require
 * convention used by the WF/ML-2 handler adapters so importing this file in a
 * unit test carries no compile-time dependency on the SDK.
 */
export class SsmParameterRuntimeUpdater implements RuntimeModelUpdater {
  private readonly parameterName: string;
  private readonly region: string;

  constructor(config: SsmParameterRuntimeUpdaterConfig = {}) {
    this.parameterName = config.parameterName ?? ACTIVE_MODEL_VERSION_PARAM;
    this.region = config.region ?? process.env.AWS_REGION ?? '';
  }

  async updateModelVersion(modelVersion: string): Promise<void> {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const client = new SSMClient(this.region ? { region: this.region } : {});
    await client.send(
      new PutParameterCommand({
        Name: this.parameterName,
        Value: modelVersion,
        Type: 'String',
        Overwrite: true,
      }),
    );
  }
}
