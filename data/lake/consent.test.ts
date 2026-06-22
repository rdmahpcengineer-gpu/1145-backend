import {
  CONSENT_SK_PREFIX,
  ConsentRecordData,
  DynamoConsentReader,
  consentSortKey,
  evaluateConsent,
  isConsentGranted,
} from './consent';

describe('lake/consent — sort key', () => {
  it('builds CONSENT#<callId>', () => {
    expect(consentSortKey('call-1')).toBe(`${CONSENT_SK_PREFIX}call-1`);
  });

  it('rejects an empty callId', () => {
    expect(() => consentSortKey('')).toThrow();
  });
});

describe('lake/consent — evaluateConsent (fail-closed, R20.2/Property 21)', () => {
  const granted: ConsentRecordData = {
    jurisdictions: { 'US-CA': { status: 'granted', capturedAt: 't' } },
  };

  it('grants only on explicit granted status for the jurisdiction', () => {
    expect(evaluateConsent(granted, 'US-CA')).toBe('granted');
    expect(isConsentGranted(evaluateConsent(granted, 'US-CA'))).toBe(true);
  });

  it('returns absent when no record exists', () => {
    expect(evaluateConsent(undefined, 'US-CA')).toBe('absent');
  });

  it('returns absent when the jurisdiction is not present', () => {
    expect(evaluateConsent(granted, 'US-NY')).toBe('absent');
    expect(evaluateConsent({ jurisdictions: {} }, 'US-CA')).toBe('absent');
    expect(evaluateConsent({}, 'US-CA')).toBe('absent');
  });

  it('returns denied on explicit denial', () => {
    const denied: ConsentRecordData = {
      jurisdictions: { 'US-CA': { status: 'denied' } },
    };
    expect(evaluateConsent(denied, 'US-CA')).toBe('denied');
    expect(isConsentGranted(evaluateConsent(denied, 'US-CA'))).toBe(false);
  });

  it('returns ambiguous for unknown/missing status (treated as input, not auth)', () => {
    const ambiguous: ConsentRecordData = {
      jurisdictions: { 'US-CA': { status: 'maybe', source: 'edge' } },
    };
    expect(evaluateConsent(ambiguous, 'US-CA')).toBe('ambiguous');
    expect(
      evaluateConsent({ jurisdictions: { 'US-CA': {} } }, 'US-CA'),
    ).toBe('ambiguous');
  });

  it('returns ambiguous when no jurisdiction can be resolved', () => {
    expect(evaluateConsent(granted, '')).toBe('ambiguous');
  });
});

describe('lake/consent — DynamoConsentReader is tenant-scoped', () => {
  it('queries PK = TENANT#<tenantId> and SK = CONSENT#<callId>', async () => {
    let issued: any;
    const query = jest.fn(async (input: any) => {
      issued = input;
      return {
        Items: [
          {
            PK: 'TENANT#acme',
            SK: 'CONSENT#call-1',
            tenantId: 'acme',
            data: { jurisdictions: { 'US-CA': { status: 'granted' } } },
          },
        ],
      };
    });
    const reader = new DynamoConsentReader({ query }, 'the-table');

    const data = await reader.read({ tenantId: 'acme', callId: 'call-1' });
    expect(data).toEqual({ jurisdictions: { 'US-CA': { status: 'granted' } } });

    expect(issued.ExpressionAttributeValues[':pk']).toBe('TENANT#acme');
    expect(issued.ExpressionAttributeValues[':sk']).toBe('CONSENT#call-1');
    expect(issued.KeyConditionExpression).toContain('#pk = :pk');
  });

  it('returns undefined when no consent record exists (fail closed upstream)', async () => {
    const query = jest.fn(async () => ({ Items: [] }));
    const reader = new DynamoConsentReader({ query }, 'the-table');
    await expect(
      reader.read({ tenantId: 'acme', callId: 'missing' }),
    ).resolves.toBeUndefined();
  });
});
