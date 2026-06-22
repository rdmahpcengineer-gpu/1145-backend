import { ConsentReader, ConsentRecordData } from './consent';
import { ConsentNotCapturedError } from './errors';
import {
  ObjectLake,
  ObjectLakeWriter,
  PutObjectInput,
} from './object-lake';

const CTX = { region: 'us-east-1', accountId: '111122223333' };

/** Capturing fake S3 writer. */
function fakeWriter(): ObjectLakeWriter & { puts: PutObjectInput[] } {
  const puts: PutObjectInput[] = [];
  return {
    puts,
    async putObject(input: PutObjectInput) {
      puts.push(input);
      return {};
    },
  };
}

/** Consent reader returning a fixed record. */
function reader(record: ConsentRecordData | undefined): ConsentReader {
  return { read: async () => record };
}

const grantedCA: ConsentRecordData = {
  jurisdictions: { 'US-CA': { status: 'granted' } },
};

function lake(
  writer: ObjectLakeWriter,
  consent: ConsentReader,
): ObjectLake {
  return new ObjectLake('the-lake', writer, {
    consentReader: consent,
    awsContext: CTX,
  });
}

describe('ObjectLake.storeAudio — consent gate (A1, R20.2, Property 21)', () => {
  it('stores audio only after consent is granted', async () => {
    const w = fakeWriter();
    const result = await lake(w, reader(grantedCA)).storeAudio({
      tenantId: 'acme',
      callId: 'call-1',
      jurisdiction: 'US-CA',
      name: 'audio.ogg',
      body: Buffer.from('bytes'),
    });

    expect(w.puts).toHaveLength(1);
    expect(result.key).toBe('acme/recordings/call-1/audio.ogg');
  });

  it('fails closed and writes NOTHING when consent is absent', async () => {
    const w = fakeWriter();
    await expect(
      lake(w, reader(undefined)).storeAudio({
        tenantId: 'acme',
        callId: 'call-1',
        jurisdiction: 'US-CA',
        name: 'audio.ogg',
        body: 'b',
      }),
    ).rejects.toBeInstanceOf(ConsentNotCapturedError);
    expect(w.puts).toHaveLength(0);
  });

  it('fails closed when consent is denied', async () => {
    const w = fakeWriter();
    await expect(
      lake(
        w,
        reader({ jurisdictions: { 'US-CA': { status: 'denied' } } }),
      ).storeAudio({
        tenantId: 'acme',
        callId: 'c',
        jurisdiction: 'US-CA',
        name: 'a.ogg',
        body: 'b',
      }),
    ).rejects.toMatchObject({ decision: 'denied' });
    expect(w.puts).toHaveLength(0);
  });

  it('fails closed when consent is ambiguous / wrong jurisdiction', async () => {
    const w = fakeWriter();
    await expect(
      lake(w, reader(grantedCA)).storeAudio({
        tenantId: 'acme',
        callId: 'c',
        jurisdiction: 'US-NY', // not the granted jurisdiction
        name: 'a.ogg',
        body: 'b',
      }),
    ).rejects.toMatchObject({ decision: 'absent' });
    expect(w.puts).toHaveLength(0);
  });
});

describe('ObjectLake — tenant partitioning + tenant KMS (R20.1/20.3, Property 8/20)', () => {
  it('encrypts audio under the OWNING tenant CP-4 key with SSE-KMS + context', async () => {
    const w = fakeWriter();
    await lake(w, reader(grantedCA)).storeAudio({
      tenantId: 'acme',
      callId: 'call-1',
      jurisdiction: 'US-CA',
      name: 'audio.ogg',
      body: 'b',
      contentType: 'audio/ogg',
    });

    const put = w.puts[0];
    expect(put.Bucket).toBe('the-lake');
    expect(put.Key.startsWith('acme/')).toBe(true);
    expect(put.ServerSideEncryption).toBe('aws:kms');
    expect(put.SSEKMSKeyId).toBe(
      'arn:aws:kms:us-east-1:111122223333:alias/tenant/acme',
    );
    expect(put.encryptionContext).toEqual({ tenant: 'acme' });
    expect(put.ContentType).toBe('audio/ogg');
  });

  it('stores documents tenant-prefixed and tenant-encrypted (no consent gate)', async () => {
    const w = fakeWriter();
    // A reader that would deny — proves documents are not gated.
    const result = await lake(w, reader(undefined)).storeDocument({
      tenantId: 'beta',
      name: 'invoice.pdf',
      body: 'pdf',
    });

    expect(result.key).toBe('beta/docs/invoice.pdf');
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0].SSEKMSKeyId).toBe(
      'arn:aws:kms:us-east-1:111122223333:alias/tenant/beta',
    );
    expect(w.puts[0].encryptionContext).toEqual({ tenant: 'beta' });
  });

  it('never resolves another tenant key for a tenant put', async () => {
    const w = fakeWriter();
    await lake(w, reader(grantedCA)).storeAudio({
      tenantId: 'acme',
      callId: 'call-1',
      jurisdiction: 'US-CA',
      name: 'a.ogg',
      body: 'b',
    });
    expect(w.puts[0].SSEKMSKeyId).toContain('alias/tenant/acme');
    expect(w.puts[0].SSEKMSKeyId).not.toContain('alias/tenant/other');
  });
});
