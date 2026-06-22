import {
  ACTION_ROUTING,
  FAILURE_SK_PREFIX,
  StepFunctionsWorkflowStarter,
  StartExecutionClient,
  StartExecutionInput,
  TenantMismatchError,
  UnknownActionError,
  buildExecutionInput,
  buildFailureRecord,
  failureSortKey,
  routeActionType,
  sanitizeExecutionName,
  workflowActionTypeFromCommand,
} from './index';
import { CommandEnvelope } from '../../control-plane/rest/handlers/workflow-client';

/**
 * Unit/example tests for the WF-1 orchestration domain (task 14.1).
 * The Property 7 / 15 / 16 property-based tests are tasks 14.2 / 14.3 / 14.4.
 */

function command(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  const base = {
    tenantId: 'acme',
    method: 'POST',
    resourcePath: '/commands/bookings',
    payload: {} as Record<string, unknown>,
    ...overrides,
  };
  // Keep commandType consistent with the route unless explicitly overridden.
  return {
    commandType: overrides.commandType ?? `${base.method} ${base.resourcePath}`,
    ...base,
  };
}

describe('routeActionType (design Property 15)', () => {
  it('routes each known action to its matching service', () => {
    expect(routeActionType('booking')).toBe('BookingService');
    expect(routeActionType('order')).toBe('OrdersService');
    expect(routeActionType('notification')).toBe('NotificationService');
  });

  it('rejects unknown action types', () => {
    expect(() => routeActionType('refund')).toThrow(UnknownActionError);
  });

  it('routing table covers exactly the three known action types', () => {
    expect(Object.keys(ACTION_ROUTING).sort()).toEqual([
      'booking',
      'notification',
      'order',
    ]);
  });
});

describe('workflowActionTypeFromCommand', () => {
  it('classifies bookings / orders / notifications from the route', () => {
    expect(workflowActionTypeFromCommand(command({ resourcePath: '/commands/bookings' }))).toBe(
      'booking',
    );
    expect(workflowActionTypeFromCommand(command({ resourcePath: '/commands/orders' }))).toBe(
      'order',
    );
    expect(
      workflowActionTypeFromCommand(command({ resourcePath: '/commands/notifications' })),
    ).toBe('notification');
  });

  it('honors an explicit actionType on the payload', () => {
    expect(
      workflowActionTypeFromCommand(
        command({ resourcePath: '/commands/anything', payload: { actionType: 'order' } }),
      ),
    ).toBe('order');
  });

  it('throws on an unroutable command', () => {
    expect(() =>
      workflowActionTypeFromCommand(command({ commandType: 'POST /commands/refunds', resourcePath: '/commands/refunds' })),
    ).toThrow(UnknownActionError);
  });
});

describe('buildExecutionInput (design Property 7)', () => {
  it('roots the input at the operative tenant', () => {
    const input = buildExecutionInput('acme', 'booking', { slot: '9am' });
    expect(input).toEqual({ tenantId: 'acme', actionType: 'booking', payload: { slot: '9am' } });
  });

  it('defaults a missing payload to an empty object', () => {
    const input = buildExecutionInput('acme', 'order', undefined as never);
    expect(input.payload).toEqual({});
  });
});

describe('failure-record shape (Requirement 13.4 / design Property 3)', () => {
  it('partitions the failure record by the owning tenant', () => {
    const item = buildFailureRecord({
      tenantId: 'acme',
      execId: 'wf1-123',
      actionType: 'booking',
      error: 'States.TaskFailed',
      cause: 'boom',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    expect(item.PK).toBe('TENANT#acme');
    expect(item.SK).toBe('FAILURE#wf1-123');
    expect(item.entityType).toBe('Failure');
    expect(item.tenantId).toBe('acme');
    expect(item.data.outcome).toBe('error');
    expect(item.data.error).toBe('States.TaskFailed');
  });

  it('builds the FAILURE# sort key', () => {
    expect(failureSortKey('exec-9')).toBe(`${FAILURE_SK_PREFIX}exec-9`);
  });

  it('rejects an invalid tenant before shaping a record', () => {
    expect(() => buildFailureRecord({ tenantId: '', execId: 'x' })).toThrow();
  });
});

describe('StepFunctionsWorkflowStarter (Requirements 2.4, 13.3)', () => {
  class FakeClient implements StartExecutionClient {
    calls: StartExecutionInput[] = [];
    async startExecution(input: StartExecutionInput) {
      this.calls.push(input);
      return { executionArn: `arn:aws:states:::execution/${input.name}` };
    }
  }

  it('starts an execution with the tenant rooted in the input', async () => {
    const client = new FakeClient();
    const starter = new StepFunctionsWorkflowStarter({
      stateMachineArn: 'arn:sm',
      client,
      nameFactory: () => 'exec-1',
    });

    const ref = await starter.start('acme', command({ payload: { slot: '9am' } }));

    expect(ref.executionId).toBe('exec-1');
    expect(ref.executionArn).toContain('exec-1');
    expect(client.calls).toHaveLength(1);
    expect(JSON.parse(client.calls[0].input)).toEqual({
      tenantId: 'acme',
      actionType: 'booking',
      payload: { slot: '9am' },
    });
  });

  it('refuses to start when the positional tenant differs from the envelope', async () => {
    const starter = new StepFunctionsWorkflowStarter({
      stateMachineArn: 'arn:sm',
      client: new FakeClient(),
    });
    await expect(starter.start('attacker', command({ tenantId: 'acme' }))).rejects.toBeInstanceOf(
      TenantMismatchError,
    );
  });

  it('sanitizes execution names to the allowed charset', () => {
    expect(sanitizeExecutionName('wf1 a/b:c')).toBe('wf1-a-b-c');
    expect(sanitizeExecutionName('')).toBe('wf1');
  });
});
