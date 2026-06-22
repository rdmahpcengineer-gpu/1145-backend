import {
  DOCS_SEGMENT,
  RECORDINGS_SEGMENT,
  documentKey,
  isUnderTenantPrefix,
  recordingKey,
  tenantPrefix,
} from './keys';
import { ObjectKeyError } from './errors';

describe('lake/keys — tenant prefix', () => {
  it('builds <tenantId>/ for a valid tenant', () => {
    expect(tenantPrefix('acme')).toBe('acme/');
  });

  it('rejects invalid tenant ids with ObjectKeyError', () => {
    expect(() => tenantPrefix('')).toThrow(ObjectKeyError);
    expect(() => tenantPrefix('a/b')).toThrow(ObjectKeyError);
    expect(() => tenantPrefix(undefined as unknown as string)).toThrow(
      ObjectKeyError,
    );
  });
});

describe('lake/keys — recording keys (R20.1, Property 20)', () => {
  it('lays out <tenantId>/recordings/<callId>/<name>', () => {
    expect(
      recordingKey({ tenantId: 'acme', callId: 'call-1', name: 'audio.ogg' }),
    ).toBe(`acme/${RECORDINGS_SEGMENT}/call-1/audio.ogg`);
  });

  it('is always prefixed by the owning tenant', () => {
    const key = recordingKey({
      tenantId: 'tenant-9',
      callId: 'c',
      name: 'a.wav',
    });
    expect(key.startsWith('tenant-9/')).toBe(true);
    expect(isUnderTenantPrefix('tenant-9', key)).toBe(true);
    expect(isUnderTenantPrefix('other', key)).toBe(false);
  });

  it('rejects a callId or name that would inject extra path segments', () => {
    expect(() =>
      recordingKey({ tenantId: 'acme', callId: 'a/b', name: 'x.ogg' }),
    ).toThrow(ObjectKeyError);
    expect(() =>
      recordingKey({ tenantId: 'acme', callId: 'c', name: '../escape' }),
    ).toThrow(ObjectKeyError);
    expect(() =>
      recordingKey({ tenantId: 'acme', callId: 'c', name: '' }),
    ).toThrow(ObjectKeyError);
  });
});

describe('lake/keys — document keys', () => {
  it('lays out <tenantId>/docs/<name>', () => {
    expect(documentKey({ tenantId: 'acme', name: 'invoice.pdf' })).toBe(
      `acme/${DOCS_SEGMENT}/invoice.pdf`,
    );
  });

  it('rejects names with slashes', () => {
    expect(() =>
      documentKey({ tenantId: 'acme', name: 'sub/dir.pdf' }),
    ).toThrow(ObjectKeyError);
  });
});
