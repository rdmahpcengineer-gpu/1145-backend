import {
  AutoApproveGate,
  ManualHoldGate,
  PredicateApprovalGate,
} from './approval-gate';
import { ObjectiveMetricComparator } from './metric-comparator';
import { ModelDeployer } from './model-deployer';
import { InMemoryRuntimeModelUpdater } from './runtime-updater';
import { ModelMetricsSnapshot } from './types';

/**
 * ML-5 Model Deployer (task 21.2 / Req 24.1, 24.2, 24.3).
 *
 * Exercised with an in-memory runtime updater and injectable comparator/gate,
 * so the promote/retain decision and the runtime-update side effect are
 * verified without live SageMaker / AgentCore. (The Property 23 PBT is 21.3.)
 */
function model(version: string, metrics: Record<string, number>): ModelMetricsSnapshot {
  return { modelVersion: version, metrics };
}

describe('ModelDeployer.evaluate — pure promote/retain decision (R24.1, R24.3)', () => {
  const deployer = new ModelDeployer({
    runtimeUpdater: new InMemoryRuntimeModelUpdater(),
  });

  it('promotes when candidate metrics exceed the deployed metrics (R24.1)', () => {
    const decision = deployer.evaluate(
      model('v2', { accuracy: 0.92 }),
      model('v1', { accuracy: 0.9 }),
    );
    expect(decision).toEqual({ kind: 'promote', modelVersion: 'v2' });
  });

  it('retains when candidate metrics do not exceed the deployed metrics (R24.3)', () => {
    const decision = deployer.evaluate(
      model('v2', { accuracy: 0.88 }),
      model('v1', { accuracy: 0.9 }),
    );
    expect(decision).toEqual({ kind: 'retain', reason: 'not-better' });
  });

  it('retains on an exact tie (strict improvement required)', () => {
    const decision = deployer.evaluate(
      model('v2', { accuracy: 0.9 }),
      model('v1', { accuracy: 0.9 }),
    );
    expect(decision).toEqual({ kind: 'retain', reason: 'not-better' });
  });

  it('promotes the first candidate when nothing is deployed yet', () => {
    const decision = deployer.evaluate(model('v1', { accuracy: 0.5 }), undefined);
    expect(decision).toEqual({ kind: 'promote', modelVersion: 'v1' });
  });

  it('retains (incomparable) when the objective metric is missing', () => {
    const decision = deployer.evaluate(
      model('v2', { f1: 0.99 }),
      model('v1', { accuracy: 0.9 }),
    );
    expect(decision).toEqual({ kind: 'retain', reason: 'incomparable' });
  });

  it('retains (incomparable) when a metric value is non-finite', () => {
    const decision = deployer.evaluate(
      model('v2', { accuracy: Number.NaN }),
      model('v1', { accuracy: 0.9 }),
    );
    expect(decision).toEqual({ kind: 'retain', reason: 'incomparable' });
  });
});

describe('ModelDeployer.deploy — applies promotion to the AC_Runtime (R24.2)', () => {
  it('updates the runtime model version on a promote', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({ runtimeUpdater: updater });

    const outcome = await deployer.deploy(
      model('v2', { accuracy: 0.95 }),
      model('v1', { accuracy: 0.9 }),
    );

    expect(outcome).toEqual({
      status: 'promoted',
      modelVersion: 'v2',
      previousVersion: 'v1',
    });
    expect(updater.currentVersion).toBe('v2');
  });

  it('does not touch the runtime when the candidate is not better (R24.3)', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({ runtimeUpdater: updater });

    const outcome = await deployer.deploy(
      model('v2', { accuracy: 0.5 }),
      model('v1', { accuracy: 0.9 }),
    );

    expect(outcome).toEqual({
      status: 'retained',
      deployedVersion: 'v1',
      reason: 'not-better',
    });
    expect(updater.currentVersion).toBe('v1');
    expect(updater.history()).toEqual(['v1']);
  });

  it('retains and does not update the runtime on incomparable metrics', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({ runtimeUpdater: updater });

    const outcome = await deployer.deploy(
      model('v2', {}),
      model('v1', { accuracy: 0.9 }),
    );

    expect(outcome.status).toBe('retained');
    expect(updater.currentVersion).toBe('v1');
  });
});

describe('ModelDeployer.deploy — A2 configurable approval-gate hook (R24.1, R24.2)', () => {
  const better = () => model('v2', { accuracy: 0.99 });
  const deployed = () => model('v1', { accuracy: 0.9 });

  it('auto-promotes by default (gate disabled)', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({
      runtimeUpdater: updater,
      approvalGate: new AutoApproveGate(),
    });

    const outcome = await deployer.deploy(better(), deployed());
    expect(outcome.status).toBe('promoted');
    expect(updater.currentVersion).toBe('v2');
  });

  it('defers an otherwise-promote decision when approval is withheld', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({
      runtimeUpdater: updater,
      approvalGate: new ManualHoldGate(),
    });

    const outcome = await deployer.deploy(better(), deployed());

    expect(outcome).toEqual({
      status: 'retained',
      deployedVersion: 'v1',
      reason: 'approval-withheld',
    });
    // The runtime was NOT updated because the gate held the promotion.
    expect(updater.currentVersion).toBe('v1');
  });

  it('passes the candidate/deployed context to a predicate gate', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const seen: string[] = [];
    const deployer = new ModelDeployer({
      runtimeUpdater: updater,
      approvalGate: new PredicateApprovalGate((req) => {
        seen.push(req.candidateVersion);
        // Only approve candidates whose accuracy clears 0.95.
        return (req.candidateMetrics.accuracy ?? 0) >= 0.95;
      }),
    });

    const outcome = await deployer.deploy(better(), deployed());
    expect(seen).toEqual(['v2']);
    expect(outcome.status).toBe('promoted');
  });

  it('never reaches the gate when metrics do not exceed (no needless approvals)', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    let gateCalls = 0;
    const deployer = new ModelDeployer({
      runtimeUpdater: updater,
      approvalGate: new PredicateApprovalGate(() => {
        gateCalls += 1;
        return true;
      }),
    });

    await deployer.deploy(model('v2', { accuracy: 0.1 }), deployed());
    expect(gateCalls).toBe(0);
  });
});

describe('ModelDeployer — lower-is-better objective (loss-style metrics)', () => {
  it('promotes when the candidate loss is strictly lower', async () => {
    const updater = new InMemoryRuntimeModelUpdater('v1');
    const deployer = new ModelDeployer({
      runtimeUpdater: updater,
      comparator: new ObjectiveMetricComparator({
        metric: 'loss',
        direction: 'lower-is-better',
      }),
    });

    const outcome = await deployer.deploy(
      model('v2', { loss: 0.1 }),
      model('v1', { loss: 0.2 }),
    );
    expect(outcome.status).toBe('promoted');
    expect(updater.currentVersion).toBe('v2');
  });
});
