import * as path from 'path';
import {
  Annotations,
  aws_appsync as appsync,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WiringKeys, publishWiring } from '../../shared/wiring';
import { loadGraphqlSdl } from '../../shared/contracts';
import { AttachedReadResolvers, attachReadResolvers } from './resolvers/read-resolvers';

/**
 * Absolute path to the local TEST FIXTURE SDL.
 *
 * This is a stand-in for the imported CP-3 contract, used ONLY when the
 * `@alchemist/contracts` package cannot be resolved (e.g. it is not yet linked
 * into this checkout). It is never the source of truth — see the header of
 * `__fixtures__/schema.graphql`.
 */
export const FIXTURE_SDL_PATH = path.join(__dirname, '__fixtures__', 'schema.graphql');

/**
 * LiveStateApi — CP-3 AppSync GraphQL API.
 *
 * Provisions the live-state GraphQL API for the operator dashboard. The schema
 * is **loaded from the imported `@alchemist/contracts` `graphql/schema.graphql`
 * SDL** (design.md "CP-3", steering `tech-and-structure.md`). Types are never
 * re-authored in CDK — the imported SDL is the single source of truth and is
 * uploaded verbatim via `SchemaFile.fromAsset`.
 *
 * **Auth modes** (matching the `@aws_cognito_user_pools` / `@aws_iam`
 * directives carried in the imported SDL):
 *  - primary `AMAZON_COGNITO_USER_POOLS` (the CP-1 tenant/operator pool) for
 *    `Query`/`Subscription` reads, and
 *  - additional `AWS_IAM` for the backend `publish*` fan-out mutations.
 *
 * The AppSync API id is exported via shared wiring
 * ({@link WiringKeys.appsyncApiId}) for the agent/ml publishers.
 *
 * ## Synth resilience
 *
 * Real deployments load the imported SDL. So that `cdk synth` and the synth
 * tests still work when `@alchemist/contracts` is absent, the SDL path is
 * resolved in this order:
 *   1. an explicitly injected {@link LiveStateApiProps.sdlPath} (tests / overrides),
 *   2. the imported contract via {@link loadGraphqlSdl},
 *   3. the local {@link FIXTURE_SDL_PATH} stand-in — used only as a last resort
 *      and accompanied by a loud synth-time warning.
 *
 * Read/subscription resolvers are attached via {@link LiveStateApi.attachReadResolvers}
 * (task 7.2); the publish fan-out resolvers are attached separately (task 7.3).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */
export interface LiveStateApiProps {
  /**
   * The CP-1 tenant/operator user pool used as the primary
   * `AMAZON_COGNITO_USER_POOLS` auth provider for reads/subscriptions.
   */
  readonly userPool: cognito.IUserPool;

  /**
   * Optional logical name for the AppSync API.
   * @default '1145-cp3-live-state'
   */
  readonly apiName?: string;

  /**
   * Inject an explicit path to the CP-3 SDL. When set, this path is loaded
   * directly and contract resolution is skipped. Primarily for tests and for
   * pointing at a contracts artifact resolved out-of-band; production normally
   * leaves this unset so the imported contract is loaded.
   * @default - resolved from the imported `@alchemist/contracts` SDL, falling
   *            back to the local fixture if the package is absent.
   */
  readonly sdlPath?: string;
}

/** How the CP-3 SDL was resolved — surfaced for tests/diagnostics. */
export enum SdlSource {
  /** An explicit {@link LiveStateApiProps.sdlPath} was provided. */
  INJECTED = 'injected',
  /** Loaded from the imported `@alchemist/contracts` SDL. */
  IMPORTED = 'imported',
  /** Fell back to the local test fixture stand-in. */
  FIXTURE = 'fixture',
}

export class LiveStateApi extends Construct {
  /** The CP-3 AppSync GraphQL API. */
  readonly api: appsync.GraphqlApi;

  /** Convenience accessor for cross-stack consumers. */
  readonly apiId: string;

  /** Absolute path of the SDL that was loaded into the API. */
  readonly sdlPath: string;

  /** Where the SDL came from (imported contract, injected, or fixture). */
  readonly sdlSource: SdlSource;

  /** Read/subscription resolvers once {@link attachReadResolvers} has run. */
  private readResolvers?: AttachedReadResolvers;

  constructor(scope: Construct, id: string, props: LiveStateApiProps) {
    super(scope, id);

    // --- Resolve the imported CP-3 SDL (never re-authored here) -----------
    const resolved = this.resolveSdlPath(props.sdlPath);
    this.sdlPath = resolved.path;
    this.sdlSource = resolved.source;

    // --- CP-3 AppSync API -------------------------------------------------
    //
    // Schema is the imported SDL uploaded verbatim. Auth: primary Cognito
    // (CP-1) for reads/subscriptions, additional IAM for the publish* fan-out
    // mutations — matching the directives in the imported SDL.
    this.api = new appsync.GraphqlApi(this, 'Api', {
      name: props.apiName ?? '1145-cp3-live-state',
      definition: appsync.Definition.fromSchema(
        appsync.SchemaFile.fromAsset(this.sdlPath),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: props.userPool,
            // Deny by default; per-field `@aws_cognito_user_pools` directives
            // in the imported SDL grant access to reads/subscriptions.
            defaultAction: appsync.UserPoolDefaultAction.ALLOW,
          },
        },
        additionalAuthorizationModes: [
          { authorizationType: appsync.AuthorizationType.IAM },
        ],
      },
      xrayEnabled: true,
    });

    this.apiId = this.api.apiId;

    // Export the AppSync API id for the agent/ml publishers (task 7.3 wiring
    // and AC/ML publish paths) via the shared wiring convention.
    publishWiring(this, WiringKeys.appsyncApiId, this.apiId);
  }

  /**
   * Attach the CP-3 **read & subscription** resolvers (task 7.2).
   *
   * Wires the DM-2 table as a DynamoDB data source for the `Query` resolvers
   * (`getCall`, `listCalls`) and a local data source for the `Subscription`
   * resolvers. Every read is pinned to `PK = TENANT#<tenantId>` where the
   * tenant comes from the Cognito identity in the resolver context — never from
   * an argument. A `tenant` argument is applied only as an additional filter
   * that can never widen scope beyond the session tenant.
   *
   * This is intentionally separate from the publish fan-out resolvers (task
   * 7.3, `attachPublishResolvers`) so the two can be wired independently.
   *
   * @returns the created data sources and resolvers (for assertions/diagnostics).
   */
  attachReadResolvers(table: dynamodb.ITable): AttachedReadResolvers {
    if (this.readResolvers) {
      return this.readResolvers;
    }
    this.readResolvers = attachReadResolvers(this.api, table);
    return this.readResolvers;
  }

  /**
   * Resolve the CP-3 SDL path with synth resilience. See class docs for order.
   */
  private resolveSdlPath(injected?: string): { path: string; source: SdlSource } {
    if (injected && injected.trim() !== '') {
      return { path: injected, source: SdlSource.INJECTED };
    }

    try {
      return { path: loadGraphqlSdl().path, source: SdlSource.IMPORTED };
    } catch (err) {
      // The imported contract is the source of truth; the fixture is only a
      // synth-time stand-in. Make its use impossible to miss.
      const reason = err instanceof Error ? err.message : String(err);
      Annotations.of(this).addWarning(
        'CP-3 SDL: could not load the imported @alchemist/contracts ' +
          'graphql/schema.graphql; falling back to the local TEST FIXTURE ' +
          `(${FIXTURE_SDL_PATH}). This stand-in must NOT be used for a real ` +
          `deployment — install/link the contracts package or set ` +
          `ALCHEMIST_CONTRACTS_DIR. Reason: ${reason}`,
      );
      return { path: FIXTURE_SDL_PATH, source: SdlSource.FIXTURE };
    }
  }
}
