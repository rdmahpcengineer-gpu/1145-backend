import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../../data/data-stack';
import { WorkflowStack } from '../workflow-stack';
import { paramName, WiringKeys } from '../../shared/wiring';
import {
  WF1_EVENT_DETAIL_TYPE,
  WF1_EVENT_SOURCE,
  WF1_FAILURE_METRIC,
  WF1_METRIC_NAMESPACE,
} from './orchestrator-construct';

/**
 * Synth assertions for the WF-1 orchestrator (task 14.1 / Requirement 13.x).
 *
 * Confirms the deployed graph is real: a state machine, an EventBridge bus +
 * routing rule, three service targets, a tenant-scoped failure write to DM-2,
 * a CloudWatch failure metric, and the exported state-machine ARN.
 */
describe('WorkflowStack — WF-1 orchestrator', () => {
  const env = { account: '111122223333', region: 'us-east-1' };

  function template(): Template {
    const app = new App();
    const dataStack = new DataStack(app, 'DataStack', { env });
    const stack = new WorkflowStack(app, 'WorkflowStack', { env, dataStack });
    return Template.fromStack(stack);
  }

  it('provisions a Step Functions state machine', () => {
    const t = template();
    t.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: '1145-wf1-orchestrator',
    });
  });

  it('provisions an EventBridge bus fronting the state machine with a routing rule', () => {
    const t = template();
    t.hasResourceProperties('AWS::Events::EventBus', { Name: '1145-wf1-bus' });
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: [WF1_EVENT_SOURCE],
        'detail-type': [WF1_EVENT_DETAIL_TYPE],
      },
    });
  });

  it('routes to three placeholder service Lambdas', () => {
    const t = template();
    // Booking + Orders + Notification placeholders.
    t.resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('routes on actionType and writes a tenant-partitioned FAILURE record', () => {
    const t = template();
    const stateMachines = t.findResources('AWS::StepFunctions::StateMachine');
    const def = JSON.stringify(Object.values(stateMachines)[0].Properties.DefinitionString);
    // Choice routes on the actionType field.
    expect(def).toContain('$.actionType');
    // Failure path writes a tenant-partitioned FAILURE#<execId> item.
    expect(def).toContain('TENANT#');
    expect(def).toContain('FAILURE#');
    // tenantId is propagated into service task inputs (design Property 7).
    expect(def).toContain('$.tenantId');
  });

  it('emits a CloudWatch failure metric on the failure path', () => {
    const t = template();
    const stateMachines = t.findResources('AWS::StepFunctions::StateMachine');
    const def = JSON.stringify(Object.values(stateMachines)[0].Properties.DefinitionString);
    expect(def).toContain(WF1_METRIC_NAMESPACE);
    expect(def).toContain(WF1_FAILURE_METRIC);
  });

  it('exports the state-machine ARN via shared/wiring', () => {
    const t = template();
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: paramName(WiringKeys.workflowStateMachineArn),
    });
  });

  it('grants the state machine write access to the DM-2 table', () => {
    const t = template();
    const policies = t.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    // The DynamoPutItem failure-recording task grants PutItem on the DM-2 table.
    expect(serialized).toContain('dynamodb:PutItem');
  });
});
