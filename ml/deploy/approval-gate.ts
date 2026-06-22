/**
 * ml/deploy/approval-gate — the configurable A2 approval-gate hook (ML-5).
 *
 * Assumption A2: promotion is automatic, but gated by a configurable
 * approval-gate hook inserted **before** the runtime update, so an operator can
 * require manual sign-off without code changes. The default is
 * disabled/auto-promote.
 *
 * This module supplies three ready-made gates; any {@link ApprovalGate} can be
 * injected into the deployer:
 *  - {@link AutoApproveGate}      — the default: always approves (gate disabled).
 *  - {@link ManualHoldGate}       — always defers: requires out-of-band sign-off.
 *  - {@link PredicateApprovalGate}— approves based on a supplied predicate.
 *
 * _Requirements: 24.1, 24.2_
 */

import { ApprovalGate, ApprovalRequest } from './types';

/**
 * The default gate: auto-promote (the hook is disabled). Every otherwise-Promote
 * decision is approved, so promotion stays automatic unless an operator opts in
 * to a stricter gate.
 */
export class AutoApproveGate implements ApprovalGate {
  approve(): boolean {
    return true;
  }
}

/**
 * A gate that always defers: an otherwise-Promote decision is held until an
 * operator signs off out of band. Use this to require manual approval without
 * changing the deployer.
 */
export class ManualHoldGate implements ApprovalGate {
  approve(): boolean {
    return false;
  }
}

/** A predicate used by {@link PredicateApprovalGate}. */
export type ApprovalPredicate = (
  request: ApprovalRequest,
) => boolean | Promise<boolean>;

/**
 * A gate that delegates to a supplied predicate, e.g. approve only above a
 * metric threshold, or consult an external approvals store. Keeps custom
 * approval policy out of the deployer.
 */
export class PredicateApprovalGate implements ApprovalGate {
  constructor(private readonly predicate: ApprovalPredicate) {}

  approve(request: ApprovalRequest): boolean | Promise<boolean> {
    return this.predicate(request);
  }
}

/**
 * Build the default approval gate from a flag (e.g. a Lambda env var). When
 * `requireApproval` is true a {@link ManualHoldGate} is returned so promotions
 * are held; otherwise the auto-promote {@link AutoApproveGate} default is used.
 */
export function approvalGateFromFlag(requireApproval: boolean): ApprovalGate {
  return requireApproval ? new ManualHoldGate() : new AutoApproveGate();
}
