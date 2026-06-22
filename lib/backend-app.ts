import { App, AppProps } from 'aws-cdk-lib';
import { DataStack } from '../data/data-stack';
import { ControlPlaneStack } from '../control-plane/control-plane-stack';
import { AgentStack } from '../agent/agent-stack';
import { WorkflowStack } from '../workflows/workflow-stack';
import { MlStack } from '../ml/ml-stack';

/**
 * BackendApp — the single CDK application for the 1145 AI AWS backend.
 *
 * Composes the five stacks aligned one-to-one with the steering folder
 * convention (design.md "CDK organization"):
 *
 *   DataStack          <- data/**          (DM-1..4)
 *   ControlPlaneStack  <- control-plane/** (CP-1..4 + CW)
 *   AgentStack         <- agent/**         (AC-1..4)
 *   WorkflowStack      <- workflows/**     (WF-1..5)
 *   MlStack            <- ml/**            (ML-1/2/4/5)
 *
 * Deploy ordering: DataStack (DM-2 table) and ControlPlaneStack (CP-4 KMS)
 * come first because every other stack depends on the table and per-tenant
 * keys. Cross-stack values are wired via stack outputs / SSM parameters
 * (see shared/wiring.ts).
 */
export class BackendApp extends App {
  readonly dataStack: DataStack;
  readonly controlPlaneStack: ControlPlaneStack;
  readonly agentStack: AgentStack;
  readonly workflowStack: WorkflowStack;
  readonly mlStack: MlStack;

  constructor(props?: AppProps) {
    super(props);

    const env = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    };

    // Wave 0/1: foundational stacks (table + per-tenant keys).
    this.dataStack = new DataStack(this, 'DataStack', { env });
    this.controlPlaneStack = new ControlPlaneStack(this, 'ControlPlaneStack', {
      env,
      dataStack: this.dataStack,
    });

    // Workflows depend on the data table.
    this.workflowStack = new WorkflowStack(this, 'WorkflowStack', {
      env,
      dataStack: this.dataStack,
    });

    // Agent depends on data, control plane (CP-3 publish), and workflows (WF-1).
    this.agentStack = new AgentStack(this, 'AgentStack', {
      env,
      dataStack: this.dataStack,
      controlPlaneStack: this.controlPlaneStack,
      workflowStack: this.workflowStack,
    });

    // ML depends on data and control plane (CP-3 publish for sentiment).
    this.mlStack = new MlStack(this, 'MlStack', {
      env,
      dataStack: this.dataStack,
      controlPlaneStack: this.controlPlaneStack,
    });

    // Explicit deploy ordering for the cross-stack dependencies.
    this.controlPlaneStack.addDependency(this.dataStack);
    this.workflowStack.addDependency(this.dataStack);
    this.agentStack.addDependency(this.dataStack);
    this.agentStack.addDependency(this.controlPlaneStack);
    this.agentStack.addDependency(this.workflowStack);
    this.mlStack.addDependency(this.dataStack);
    this.mlStack.addDependency(this.controlPlaneStack);
  }
}
