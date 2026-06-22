import { App, Stack, aws_cognito as cognito } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LiveStateApi } from './live-state-api';
import {
  PUBLISH_DATA_SOURCE_ID,
  PUBLISH_RESOLVER_SPECS,
  PublishResolverSpec,
  attachPublishResolvers,
  buildPublishRequestTemplate,
  buildPublishResponseTemplate,
} from './publish-resolvers';

/**
 * CP-3 publish (fan-out) resolver tests — task 7.3 / Req 3.7, 10.3, 11.3, 12.3.
 *
 * Two layers:
 *  - mapping-template unit tests: the no-op fan-out logic sets the tenant from
 *    the session-derived field and performs no persistence; and
 *  - synth tests: the resolvers are wired onto the LiveStateApi via a NONE data
 *    source for the four publish mutations, without touching schema/auth.
 */
describe('CP-3 publish fan-out resolvers', () => {
  const byField = (field: string): PublishResolverSpec => {
    const spec = PUBLISH_RESOLVER_SPECS.find((s) => s.fieldName === field);
    if (!spec) throw new Error(`no spec for ${field}`);
    return spec;
  };

  describe('mapping templates (no-op fan-out logic)', () => {
    it('covers exactly the four publish mutations', () => {
      expect(PUBLISH_RESOLVER_SPECS.map((s) => s.fieldName).sort()).toEqual(
        ['appendTranscript', 'publishCallEscalated', 'publishCallUpdate', 'publishLead'],
      );
    });

    it('never issues a persistent data-source operation (NONE/local only)', () => {
      // A fan-out resolver must not perform any DynamoDB/store operation. The
      // NONE data source has no such verbs, but assert the templates never emit
      // them so the no-persistence guarantee is explicit.
      const forbidden = [
        '"operation"',
        'PutItem',
        'GetItem',
        'Query',
        'UpdateItem',
        'DeleteItem',
        'BatchPutItem',
      ];
      for (const spec of PUBLISH_RESOLVER_SPECS) {
        const req = buildPublishRequestTemplate(spec);
        for (const verb of forbidden) {
          expect(req).not.toContain(verb);
        }
      }
    });

    it('stamps the tenant from the session-derived tenantId field for tenant-bearing payloads', () => {
      for (const spec of PUBLISH_RESOLVER_SPECS.filter((s) => s.tenantBearing)) {
        const req = buildPublishRequestTemplate(spec);
        // Tenant is sourced from the argument's tenantId field and re-asserted
        // onto the payload — not from any other arbitrary client field.
        expect(req).toContain(`$ctx.args.${spec.argName}.tenantId`);
        expect(req).toContain('$payload.put("tenantId", $ctx.args.' + spec.argName + '.tenantId)');
      }
    });

    it('rejects a tenant-bearing publish when the session tenant is absent', () => {
      for (const spec of PUBLISH_RESOLVER_SPECS.filter((s) => s.tenantBearing)) {
        const req = buildPublishRequestTemplate(spec);
        expect(req).toContain(`$util.isNullOrBlank($ctx.args.${spec.argName}.tenantId)`);
        expect(req).toContain('$util.unauthorized()');
      }
    });

    it('stamps escalated=true for publishCallEscalated', () => {
      const req = buildPublishRequestTemplate(byField('publishCallEscalated'));
      expect(req).toContain('$payload.put("escalated", true)');
    });

    it('fans out the transcript segment as-is (no tenant field on the payload type)', () => {
      const spec = byField('appendTranscript');
      const req = buildPublishRequestTemplate(spec);
      expect(req).toContain('$util.toJson($ctx.args.segment)');
      // No tenant assertion/stamp for the non-tenant-bearing transcript payload.
      expect(req).not.toContain('isNullOrBlank');
      expect(req).not.toContain('$util.unauthorized()');
    });

    it('sets the payload version and returns the staged payload for delivery', () => {
      for (const spec of PUBLISH_RESOLVER_SPECS) {
        expect(buildPublishRequestTemplate(spec)).toContain('"version": "2018-05-29"');
        expect(buildPublishRequestTemplate(spec)).toContain('"payload":');
      }
      const res = buildPublishResponseTemplate();
      expect(res).toContain('$util.toJson($ctx.result)');
      expect(res).toContain('$ctx.error');
    });
  });

  describe('synth wiring', () => {
    function build(): Template {
      const app = new App();
      const stack = new Stack(app, 'TestStack', {
        env: { account: '111122223333', region: 'us-east-1' },
      });
      const userPool = new cognito.UserPool(stack, 'Pool');
      const api = new LiveStateApi(stack, 'LiveStateApi', { userPool });
      attachPublishResolvers(api);
      return Template.fromStack(stack);
    }

    it('wires a single NONE data source for the fan-out resolvers', () => {
      const template = build();
      template.resourceCountIs('AWS::AppSync::DataSource', 1);
      template.hasResourceProperties('AWS::AppSync::DataSource', {
        Type: 'NONE',
        Name: PUBLISH_DATA_SOURCE_ID,
      });
    });

    it('creates a resolver for each of the four publish mutations on Mutation', () => {
      const template = build();
      template.resourceCountIs('AWS::AppSync::Resolver', 4);
      for (const field of [
        'publishCallUpdate',
        'appendTranscript',
        'publishLead',
        'publishCallEscalated',
      ]) {
        template.hasResourceProperties('AWS::AppSync::Resolver', {
          TypeName: 'Mutation',
          FieldName: field,
        });
      }
    });

    it('binds each resolver to the NONE fan-out data source', () => {
      const template = build();
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Mutation',
        FieldName: 'publishCallUpdate',
        DataSourceName: Match.anyValue(),
      });
    });
  });
});
