import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DataStack } from '../data/data-stack';
import { WiringKeys, publishWiring } from '../shared/wiring';
import { WorkflowOrchestrator } from './orchestrator/orchestrator-construct';

/**
 * WorkflowStack — owns `workflows/**` (WF-1..5).
 *
 * Filled in by later tasks:
 *  - 14.1 WF-1 Step Functions + EventBridge orchestrator (exports state-machine ARN) ✅
 *  - 15.1 WF-2 Booking Lambda
 *  - 16.1 WF-3 Orders Lambda
 *  - 17.1 WF-4/5 Notification Lambda (SES, SNS/Pinpoint)
 */
export interface WorkflowStackProps extends StackProps {
  /** DataStack reference for persisting bookings/orders/failures to DM-2. */
  readonly dataStack: DataStack;
}

export class WorkflowStack extends Stack {
  /** WF-1 orchestrator — Step Functions state machine fronted by EventBridge. */
  readonly orchestrator: WorkflowOrchestrator;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);

    // 14.1 — WF-1 orchestrator. A Step Functions state machine fronted by an
    // EventBridge bus that routes an initiating action (Tool Gateway or CP-2
    // command) to Booking / Orders / Notification by `actionType`, propagates
    // `tenantId` into every state input (design Property 7), and on a step
    // failure writes a tenant-scoped `FAILURE#<execId>` item to the DM-2 table,
    // emits a CloudWatch metric, and surfaces an error outcome (design
    // Property 16). Booking/Orders/Notification are placeholder Lambdas owned by
    // tasks 15.1 / 16.1 / 17.1.
    this.orchestrator = new WorkflowOrchestrator(this, 'Orchestrator', {
      table: props.dataStack.table,
    });

    // Export the WF-1 state-machine ARN so CP-2 command handlers (task 6.2) and
    // the AC-2 Tool Gateway can route to WF-1 via the concrete
    // StepFunctionsWorkflowStarter (workflows/orchestration).
    publishWiring(
      this,
      WiringKeys.workflowStateMachineArn,
      this.orchestrator.stateMachine.stateMachineArn,
    );
  }
}
