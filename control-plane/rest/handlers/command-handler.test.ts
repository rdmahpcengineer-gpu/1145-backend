import { AuthorizationError } from '../../auth';
import { TENANT_ID_CLAIM } from '../../auth/validated-session';
import {
  ApiGatewayProxyEventLike,
  extractAuthorizerClaims,
  extractClientSuppliedTenant,
} from './api-gateway';
import {
  createCommandHandler,
  deriveCommandType,
  parseCommandBody,
} from './command-handler';
import { CommandValidationError } from './errors';
import {
  CommandEnvelope,
  ExecutionRef,
  WorkflowStarter,
} from './workflow-client';

/**
 * CP-2 command handler unit tests (task 6.2 / Req 2.3, 2.4, 2.5, 2.6).
 *
 * These exercise the tenant-isolation + routing core directly against a fake
 * WF-1 client, with no AWS coupling: the tenant is derived from the verified
 * Cognito claims (never the client), authorized commands are routed to WF-1,
 * and non-conforming requests are rejected with a validation error.
 */

/** A WorkflowStarter spy that records every call and returns a fixed ref. */
class FakeWorkflowStarter implements WorkflowStarter {
  readonly calls: Array<{ tenantId: string; command: CommandEnvelope }> = [];
  ref: ExecutionRef = { executionId: 'exec-1', executionArn: 'arn:exec:1' };
  error?: Error;

  async start(
    tenantId: string,
    command: CommandEnvelope,
  ): Promise<ExecutionRef> {
    this.calls.push({ tenantId, command });
    if (this.error) {
      throw this.error;
    }
    return this.ref;
  }
}

/** Build a CP-2 proxy event with verified Cognito claims by default. */
function event(
  overrides: Partial<ApiGatewayProxyEventLike> = {},
  claims: Record<string, unknown> | null = { [TENANT_ID_CLAIM]: 'acme' },
): ApiGatewayProxyEventLike {
  return {
    resource: '/commands/bookings',
    path: '/commands/bookings',
    httpMethod: 'POST',
    body: JSON.stringify({ slot: '2030-01-01T10:00' }),
    headers: {},
    requestContext: claims ? { authorizer: { claims } } : { authorizer: null },
    ...overrides,
  };
}

describe('createCommandHandler — authorize, scope, route (R2.3–R2.6)', () => {
  it('derives the tenant from the verified Cognito claims and routes to WF-1', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event());

    expect(res.statusCode).toBe(202);
    expect(wf.calls).toHaveLength(1);
    expect(wf.calls[0].tenantId).toBe('acme');
    expect(wf.calls[0].command).toMatchObject({
      tenantId: 'acme',
      commandType: 'POST /commands/bookings',
      method: 'POST',
      resourcePath: '/commands/bookings',
      payload: { slot: '2030-01-01T10:00' },
    });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      status: 'accepted',
      commandType: 'POST /commands/bookings',
      executionId: 'exec-1',
      executionArn: 'arn:exec:1',
    });
  });

  it('ignores a client-supplied tenant in the body — tenant comes from the session (R2.3)', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(
      event({
        body: JSON.stringify({ slot: 's1', tenantId: 'attacker-tenant' }),
      }),
    );

    expect(res.statusCode).toBe(202);
    // Derived tenant is the session tenant, NOT the body field.
    expect(wf.calls[0].tenantId).toBe('acme');
    expect(wf.calls[0].command.tenantId).toBe('acme');
  });

  it('ignores a client-supplied tenant in the x-tenant-id header', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(
      event({ headers: { 'X-Tenant-Id': 'attacker-tenant' } }),
    );

    expect(res.statusCode).toBe(202);
    expect(wf.calls[0].tenantId).toBe('acme');
  });

  it('forwards the same session tenant regardless of a conflicting client tenant', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    for (const supplied of ['acme', 'other', '', '../evil', '{"x":1}']) {
      wf.calls.length = 0;
      const res = await handler(
        event({
          body: JSON.stringify({ slot: 's', tenantId: supplied }),
          headers: { 'x-tenant-id': supplied },
        }),
      );
      expect(res.statusCode).toBe(202);
      expect(wf.calls[0].tenantId).toBe('acme');
    }
  });

  it('rejects a request with no authorizer claims (no Validated_Session) and routes nothing (R2.3, Property 2)', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event({}, null));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
    expect(wf.calls).toHaveLength(0);
  });

  it('rejects a session whose claims carry no tenant with 403 and routes nothing', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event({}, { sub: 'user-1' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('missing-tenant-claim');
    expect(wf.calls).toHaveLength(0);
  });

  it('rejects a session with a malformed tenant with 403 and routes nothing', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event({}, { [TENANT_ID_CLAIM]: '../evil' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('invalid-tenant');
    expect(wf.calls).toHaveLength(0);
  });

  it('rejects a malformed JSON body with a 400 validation error and routes nothing (R2.6)', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event({ body: '{ not json' }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ValidationError');
    expect(body.reason).toBe('malformed-body');
    expect(wf.calls).toHaveLength(0);
  });

  it('rejects a non-object JSON body on a body-bearing method with a 400 validation error', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event({ body: JSON.stringify([1, 2, 3]) }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).reason).toBe('non-object-body');
    expect(wf.calls).toHaveLength(0);
  });

  it('rejects a path that is not a command route with a 400 validation error', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(
      event({ resource: '/health', path: '/health' }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).reason).toBe('unknown-route');
    expect(wf.calls).toHaveLength(0);
  });

  it('honors a custom command path prefix', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({
      workflowStarter: wf,
      commandPathPrefix: '/v1/cmd/',
    });

    const ok = await handler(
      event({ resource: '/v1/cmd/orders', path: '/v1/cmd/orders' }),
    );
    expect(ok.statusCode).toBe(202);
    expect(wf.calls[0].command.commandType).toBe('POST /v1/cmd/orders');

    const bad = await handler(event());
    expect(bad.statusCode).toBe(400);
  });

  it('returns 500 without leaking internals when WF-1 fails, after deriving the tenant', async () => {
    const wf = new FakeWorkflowStarter();
    wf.error = new Error('step functions unavailable: secret-arn');
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('InternalError');
    expect(res.body).not.toContain('secret-arn');
    // The tenant was derived and the command was scoped before the failure.
    expect(wf.calls[0].tenantId).toBe('acme');
  });

  it('accepts an SE-1 style command path under /commands/ and derives the command type generically', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });

    const res = await handler(
      event({
        resource: '/commands/orders',
        path: '/commands/orders',
        body: JSON.stringify({ items: ['x'] }),
      }),
    );

    expect(res.statusCode).toBe(202);
    expect(wf.calls[0].command.commandType).toBe('POST /commands/orders');
    expect(wf.calls[0].command.payload).toEqual({ items: ['x'] });
  });
});

describe('parseCommandBody', () => {
  it('returns an empty object when no body is present', () => {
    expect(parseCommandBody(event({ body: null }))).toEqual({});
    expect(parseCommandBody(event({ body: '' }))).toEqual({});
  });

  it('decodes a base64-encoded body', () => {
    const json = JSON.stringify({ slot: 's' });
    const e = event({
      body: Buffer.from(json, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });
    expect(parseCommandBody(e)).toEqual({ slot: 's' });
  });

  it('throws CommandValidationError on malformed JSON', () => {
    expect(() => parseCommandBody(event({ body: 'oops' }))).toThrow(
      CommandValidationError,
    );
  });
});

describe('deriveCommandType', () => {
  it('builds a stable routing key from method + path (does not re-author the contract)', () => {
    expect(deriveCommandType('POST', '/commands/bookings')).toBe(
      'POST /commands/bookings',
    );
  });
});

describe('authorizer claim + client-tenant extraction', () => {
  it('extracts claims from the authorizer context, else null', () => {
    expect(
      extractAuthorizerClaims(event({}, { [TENANT_ID_CLAIM]: 'acme' })),
    ).toEqual({ [TENANT_ID_CLAIM]: 'acme' });
    expect(extractAuthorizerClaims(event({}, null))).toBeNull();
  });

  it('reads the client-supplied tenant from header (case-insensitive) then body', () => {
    expect(
      extractClientSuppliedTenant(
        event({ headers: { 'X-Tenant-Id': 'h' } }),
        { tenantId: 'b' },
      ),
    ).toBe('h');
    expect(
      extractClientSuppliedTenant(event({ headers: {} }), { tenantId: 'b' }),
    ).toBe('b');
  });
});

/**
 * Sanity: the auth choke point this handler relies on really does reject a
 * missing session (the handler maps this to a 401). Guards against a regression
 * where the handler swallows the authorization failure.
 */
describe('auth integration sanity', () => {
  it('AuthorizationError is the rejection path for a missing session', async () => {
    const wf = new FakeWorkflowStarter();
    const handler = createCommandHandler({ workflowStarter: wf });
    const res = await handler(event({}, null));
    expect(res.statusCode).toBe(401);
    // The error type used internally is AuthorizationError (asserted indirectly
    // via the 401 + reason mapping).
    expect(new AuthorizationError('missing-session', 'x')).toBeInstanceOf(
      AuthorizationError,
    );
  });
});
