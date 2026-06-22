import { App, Stack, aws_cognito as cognito, aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LiveStateApi } from '../live-state-api';
import { CALL_SK_PREFIX, TENANT_PK_PREFIX } from './read-resolvers';

/**
 * CP-3 read/subscription resolver synth assertions (task 7.2 / Req 3.5, 3.6).
 *
 * Confirms `attachReadResolvers` wires the DM-2 table as a DynamoDB data
 * source, attaches the Query and Subscription resolvers, and that the emitted
 * resolver templates pin the tenant scope to the Cognito identity.
 */
describe('LiveStateApi.attachReadResolvers — CP-3 read/subscription resolvers', () => {
  function build(): { template: Template } {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const table = new dynamodb.Table(stack, 'Dm2Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    });
    const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
    api.attachReadResolvers(table);
    return { template: Template.fromStack(stack) };
  }

  it('creates a DynamoDB data source and a NONE data source', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::AppSync::DataSource', {
      Type: 'AMAZON_DYNAMODB',
    });
    template.hasResourceProperties('AWS::AppSync::DataSource', {
      Type: 'NONE',
    });
  });

  it('attaches Query resolvers for getCall and listCalls', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Query',
      FieldName: 'getCall',
    });
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Query',
      FieldName: 'listCalls',
    });
  });

  it('attaches Subscription resolvers for the fan-out fields', () => {
    const { template } = build();
    for (const fieldName of ['onCallUpdate', 'onLead', 'onTranscript']) {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Subscription',
        FieldName: fieldName,
      });
    }
  });

  it('pins read resolvers to the tenant partition from the Cognito identity', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Query',
      FieldName: 'getCall',
      RequestMappingTemplate: Match.stringLikeRegexp(
        `[\\s\\S]*custom:tenantId[\\s\\S]*${TENANT_PK_PREFIX}[\\s\\S]*${CALL_SK_PREFIX}[\\s\\S]*`,
      ),
    });
  });

  it('sets a tenant subscription filter on the fan-out resolvers', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Subscription',
      FieldName: 'onCallUpdate',
      ResponseMappingTemplate: Match.stringLikeRegexp(
        '[\\s\\S]*tenantId[\\s\\S]*setSubscriptionFilter[\\s\\S]*',
      ),
    });
  });

  it('is idempotent — repeated attach calls do not duplicate data sources', () => {
    const app = new App();
    const stack = new Stack(app, 'IdempotentStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const userPool = new cognito.UserPool(stack, 'Pool');
    const table = new dynamodb.Table(stack, 'Dm2Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    });
    const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
    const first = api.attachReadResolvers(table);
    const second = api.attachReadResolvers(table);
    expect(second).toBe(first);
    const template = Template.fromStack(stack);
    // 1 DynamoDB + 1 NONE data source only.
    template.resourceCountIs('AWS::AppSync::DataSource', 2);
  });
});
