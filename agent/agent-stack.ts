import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DataStack } from '../data/data-stack';
import { ControlPlaneStack } from '../control-plane/control-plane-stack';
import { WorkflowStack } from '../workflows/workflow-stack';

/**
 * AgentStack — owns `agent/**` (AC-1..4).
 *
 * The AgentCore Python code is forked from
 * `awslabs/amazon-bedrock-agentcore-samples` and lives under `agent/src/**`.
 *
 * Filled in by later tasks:
 *  - 9.1 SE-1 session validator (A3)
 *  - 9.2 AC-1 runtime + session context
 *  - 10.1 AC-2 Tool Gateway -> WF-1
 *  - 11.1 AC-3 Memory hydration
 *  - 12.x AC-4 Bedrock reasoner, escalation, live publication, lead extraction
 */
export interface AgentStackProps extends StackProps {
  readonly dataStack: DataStack;
  readonly controlPlaneStack: ControlPlaneStack;
  readonly workflowStack: WorkflowStack;
}

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    // Intentionally empty — provisioned by tasks 9.x / 10.x / 11.x / 12.x.
  }
}
