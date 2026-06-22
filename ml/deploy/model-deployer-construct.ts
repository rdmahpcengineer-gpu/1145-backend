/**
 * ml/deploy/model-deployer-construct — the ML-5 Model Deployer construct (design ML-5).
 *
 * Provisions the infrastructure for the Model Deployer (Requirements 24.1,
 * 24.2, 24.3). The promote/retain logic lives in `ml/deploy/**` and is testable
 * without AWS; this construct only wires it to AWS:
 *
 *  - An **SSM String parameter** holding the AC_Runtime's active reasoner model
 *    version — the deploy target. On a promote the deployer writes the promoted
 *    version here; the AgentCore runtime reads it when opening a session
 *    (seeding `Session.model_version`), which is how the runtime is "updated to
 *    use the promoted model version" (R24.2).
 *  - A **Node 20 deployer Lambda** running `ml/deploy/handler`, granted
 *    least-privilege `ssm:PutParameter` on exactly that parameter.
 *  - The **A2 approval-gate hook** is configured (not hard-coded) via the
 *    Lambda's environment: `requireApproval` defaults to false (auto-promote)
 *    and can be flipped on to require manual sign-off without a code change.
 *
 * Self-contained so it can be instantiated from `MlStack` with a single
 * additive edit, alongside the concurrently-added ML-1/ML-2/ML-4 constructs.
 *
 * _Requirements: 24.1, 24.2, 24.3_
 */

import * as path from 'path';
import {
  Duration,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  ACTIVE_MODEL_VERSION_PARAM_ENV,
  REQUIRE_APPROVAL_ENV,
} from './handler';
import { ACTIVE_MODEL_VERSION_PARAM } from './runtime-updater';

export interface ModelDeployerProps {
  /**
   * Whether to require manual operator sign-off before a promote updates the
   * runtime (the A2 approval-gate hook). Defaults to `false` — auto-promote.
   */
  readonly requireApproval?: boolean;

  /**
   * Name of the SSM parameter holding the AC_Runtime active model version.
   * Defaults to {@link ACTIVE_MODEL_VERSION_PARAM}.
   */
  readonly activeModelVersionParam?: string;

  /** Initial active model version seeded into the parameter. Defaults to `none`. */
  readonly initialModelVersion?: string;
}

export class ModelDeployerConstruct extends Construct {
  /** The ML-5 deployer Lambda (compares metrics, promotes on approval). */
  readonly function: lambda.Function;

  /** SSM parameter holding the AC_Runtime active model version (the deploy target). */
  readonly activeModelVersionParameter: ssm.StringParameter;

  /** Resolved active-model-version parameter name. */
  readonly activeModelVersionParamName: string;

  constructor(scope: Construct, id: string, props: ModelDeployerProps = {}) {
    super(scope, id);

    this.activeModelVersionParamName =
      props.activeModelVersionParam ?? ACTIVE_MODEL_VERSION_PARAM;

    // The deploy target: the AC_Runtime reads its active model version here.
    this.activeModelVersionParameter = new ssm.StringParameter(
      this,
      'ActiveModelVersion',
      {
        parameterName: this.activeModelVersionParamName,
        stringValue: props.initialModelVersion ?? 'none',
        description:
          'ML-5: active AC_Runtime reasoner model version (updated on promote)',
      },
    );

    this.function = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      timeout: Duration.seconds(30),
      description:
        'ML-5 Model Deployer — promotes a registered model iff its metrics exceed the deployed model (A2 approval hook)',
      code: lambda.Code.fromAsset(path.join(__dirname)),
      environment: {
        // A2 approval-gate hook: configurable, default auto-promote.
        [REQUIRE_APPROVAL_ENV]: String(props.requireApproval ?? false),
        [ACTIVE_MODEL_VERSION_PARAM_ENV]: this.activeModelVersionParamName,
      },
    });

    // Least privilege: the deployer may only write the active-model-version
    // parameter (its sole "apply promotion" side effect, R24.2).
    this.activeModelVersionParameter.grantWrite(this.function);
    // Defensively deny everything but PutParameter on that one parameter.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PromoteUpdatesActiveModelVersionOnly',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:PutParameter'],
        resources: [this.activeModelVersionParameter.parameterArn],
      }),
    );
  }
}
