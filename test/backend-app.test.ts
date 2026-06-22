import * as fc from 'fast-check';
import { Template } from 'aws-cdk-lib/assertions';
import { BackendApp } from '../lib/backend-app';

/**
 * Placeholder test confirming the test runner (jest) and the property-based
 * testing library (fast-check) are wired up, and that BackendApp synthesizes
 * its five stacks. Real property tests are added by the `*` test sub-tasks.
 */
describe('BackendApp scaffolding', () => {
  it('composes the five backend stacks', () => {
    const app = new BackendApp();
    const stackIds = app.node.children
      .filter((c) => 'templateOptions' in c)
      .map((c) => c.node.id)
      .sort();

    expect(stackIds).toEqual([
      'AgentStack',
      'ControlPlaneStack',
      'DataStack',
      'MlStack',
      'WorkflowStack',
    ]);
  });

  it('each stack synthesizes to a valid template', () => {
    const app = new BackendApp();
    for (const stack of [
      app.dataStack,
      app.controlPlaneStack,
      app.agentStack,
      app.workflowStack,
      app.mlStack,
    ]) {
      // Synthesizes without error.
      expect(() => Template.fromStack(stack)).not.toThrow();
    }
  });

  it('fast-check runs property tests (smoke)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
      { numRuns: 100 },
    );
  });
});
