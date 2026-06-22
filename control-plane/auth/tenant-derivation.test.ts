import {
  AuthorizationError,
  TENANT_ID_CLAIM,
  cognitoSession,
  deriveOperativeTenantId,
  deriveTenantId,
  isValidatedSession,
  se1Session,
} from './index';
import { TENANT_ID_CLAIM as COGNITO_CONSTRUCT_CLAIM } from '../cognito/tenant-user-pool';

describe('TENANT_ID_CLAIM', () => {
  it('matches the claim declared by the CP-1 Cognito construct (no drift)', () => {
    // The auth helper deliberately avoids importing the CDK construct at
    // runtime; this test is the guard that the duplicated constant stays in
    // sync with the source of truth.
    expect(TENANT_ID_CLAIM).toBe(COGNITO_CONSTRUCT_CLAIM);
    expect(TENANT_ID_CLAIM).toBe('custom:tenantId');
  });
});

describe('deriveTenantId — Cognito session', () => {
  it('derives the tenant from the verified custom:tenantId claim', () => {
    const session = cognitoSession({
      sub: 'op-1',
      email: 'op@acme.test',
      [TENANT_ID_CLAIM]: 'acme',
    });
    expect(deriveTenantId(session)).toBe('acme');
  });

  it('rejects a Cognito session with no tenant claim', () => {
    const session = cognitoSession({ sub: 'op-1', email: 'op@acme.test' });
    let caught: unknown;
    try {
      deriveTenantId(session);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('missing-tenant-claim');
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('rejects a Cognito session whose tenant claim is %s', (_label, value) => {
    const session = cognitoSession({ [TENANT_ID_CLAIM]: value });
    expect(() => deriveTenantId(session)).toThrow(AuthorizationError);
  });

  it.each([
    ['slash injection', 'acme/evil'],
    ['leading dash', '-bad'],
    ['too long', 'x'.repeat(200)],
    ['non-string', 12345],
  ])('rejects a Cognito session with an invalid tenant claim (%s)', (_label, value) => {
    const session = cognitoSession({ [TENANT_ID_CLAIM]: value });
    let caught: unknown;
    try {
      deriveTenantId(session);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('invalid-tenant');
  });
});

describe('deriveTenantId — validated SE-1 session', () => {
  it('derives the tenant emitted by the SE-1 validator', () => {
    expect(deriveTenantId(se1Session('tenant-9'))).toBe('tenant-9');
  });

  it('rejects a validated SE-1 session with a malformed tenant', () => {
    let caught: unknown;
    try {
      deriveTenantId(se1Session('bad/tenant'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('invalid-tenant');
  });
});

describe('deriveTenantId — no Validated_Session (R1.5)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects when the session is %s', (_label, session) => {
    let caught: unknown;
    try {
      deriveTenantId(session);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('missing-session');
  });

  it.each([
    ['empty object', {}],
    ['unknown kind', { kind: 'apiKey', tenantId: 'acme' }],
    ['array', []],
    ['string', 'acme'],
  ])('rejects an unrecognized session shape (%s)', (_label, session) => {
    let caught: unknown;
    try {
      // @ts-expect-error exercising invalid runtime input
      deriveTenantId(session);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('unrecognized-session');
  });
});

describe('deriveOperativeTenantId — ignores client-supplied tenant (R1.4, Property 1)', () => {
  it('returns the session tenant when no client tenant is supplied', () => {
    expect(
      deriveOperativeTenantId({
        session: cognitoSession({ [TENANT_ID_CLAIM]: 'acme' }),
      }),
    ).toBe('acme');
  });

  it.each([
    ['absent', undefined],
    ['equal', 'acme'],
    ['conflicting', 'attacker'],
    ['conflicting object', { tenantId: 'attacker' }],
  ])(
    'derives the session tenant regardless of a %s client-supplied tenant',
    (_label, clientSuppliedTenantId) => {
      const result = deriveOperativeTenantId({
        session: cognitoSession({ [TENANT_ID_CLAIM]: 'acme' }),
        clientSuppliedTenantId,
      });
      expect(result).toBe('acme');
    },
  );

  it('ignores a conflicting client tenant on an SE-1 session too', () => {
    expect(
      deriveOperativeTenantId({
        session: se1Session('voice-tenant'),
        clientSuppliedTenantId: 'attacker',
      }),
    ).toBe('voice-tenant');
  });

  it('still rejects when there is no session even if a client tenant is supplied', () => {
    let caught: unknown;
    try {
      deriveOperativeTenantId({
        session: null,
        clientSuppliedTenantId: 'attacker',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).reason).toBe('missing-session');
  });
});

describe('isValidatedSession', () => {
  it('recognizes Cognito and SE-1 sessions', () => {
    expect(isValidatedSession(cognitoSession({}))).toBe(true);
    expect(isValidatedSession(se1Session('acme'))).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['plain object', {}],
    ['unknown kind', { kind: 'apiKey' }],
    ['string', 'acme'],
  ])('rejects non-sessions (%s)', (_label, value) => {
    expect(isValidatedSession(value)).toBe(false);
  });
});
