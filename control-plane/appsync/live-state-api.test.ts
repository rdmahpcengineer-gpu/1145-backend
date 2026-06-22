import { App, Stack, aws_cognito as cognito } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LiveStateApi, SdlSource } from './live-state-api';

/**
 * CP-3 AppSync synth assertions (task 7.1 / Req 3.1–3.4).
 *
 * Confirms the API is provisioned from a loaded SDL (not hand-authored types
 * in CDK) with the two required auth modes: primary Cognito user pools for
 * reads/subscriptions and additional IAM for the publish* fan-out mutations.
 *
 * The `@alchemist/contracts` package is not linked in this checkout, so the
 * construct resolves to the local TEST FIXTURE stand-in — which is exactly the
 * synth-resilience path these tests exercise.
 */
describe('LiveStateApi — CP-3 AppSync', () => {
  function build(): { template: Template; api: LiveStateApi } {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
    return { template: Template.fromStack(stack), api };
  }

  it('provisions a single AppSync GraphQL API', () => {
    const { template } = build();
    template.resourceCountIs('AWS::AppSync::GraphQLApi', 1);
  });

  it('uses Cognito user pools as the primary auth and IAM as additional', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::AppSync::GraphQLApi', {
      AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
      UserPoolConfig: Match.objectLike({ DefaultAction: 'ALLOW' }),
      AdditionalAuthenticationProviders: Match.arrayWith([
        Match.objectLike({ AuthenticationType: 'AWS_IAM' }),
      ]),
    });
  });

  it('loads the schema from the SDL file rather than inline CDK-authored types', () => {
    const { template } = build();
    // The schema definition is the loaded SDL text uploaded verbatim — the
    // publish* mutations and their @aws_iam / @aws_cognito_user_pools
    // directives come straight from the file, not from CDK type-building APIs.
    template.hasResourceProperties('AWS::AppSync::GraphQLSchema', {
      Definition: Match.stringLikeRegexp('[\\s\\S]*publishCallUpdate[\\s\\S]*@aws_iam[\\s\\S]*'),
    });
  });

  it('exports the AppSync API id via shared wiring (SSM parameter)', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/1145/aws-backend/control-plane/appsync-api-id',
    });
  });

  it('falls back to the local fixture stand-in when contracts are absent', () => {
    const { api } = build();
    expect(api.sdlSource).toBe(SdlSource.FIXTURE);
    expect(api.sdlPath).toMatch(/__fixtures__[/\\]schema\.graphql$/);
  });

  it('loads an injected SDL path directly without contract resolution', () => {
    const app = new App();
    const stack = new Stack(app, 'InjectStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const injected = require('path').join(
      __dirname,
      '__fixtures__',
      'schema.graphql',
    );
    const api = new LiveStateApi(stack, 'LiveStateApi', {
      userPool,
      sdlPath: injected,
    });
    expect(api.sdlSource).toBe(SdlSource.INJECTED);
    expect(api.sdlPath).toBe(injected);
  });
});
