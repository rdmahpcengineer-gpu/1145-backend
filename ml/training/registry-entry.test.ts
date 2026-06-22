import { buildRegistryEntry } from './registry-entry';
import { RegistryEntryError } from './errors';

/**
 * ML-4 registry-entry construction (task 21.1 / Req 23.2, 23.3).
 *
 * A registry entry must identify a model version and carry finite evaluation
 * metrics, with an ISO-8601 `registeredAt`.
 */
describe('training/registry-entry — buildRegistryEntry (R23.2, R23.3)', () => {
  it('builds an entry that identifies the model version and records metrics', () => {
    const entry = buildRegistryEntry({
      modelVersion: 'v3',
      metrics: { accuracy: 0.91, f1: 0.88 },
      registeredAt: '2024-01-02T03:04:05.000Z',
    });

    expect(entry.modelVersion).toBe('v3');
    expect(entry.metrics).toEqual({ accuracy: 0.91, f1: 0.88 });
    expect(entry.registeredAt).toBe('2024-01-02T03:04:05.000Z');
  });

  it('accepts a Date and normalises registeredAt to ISO-8601', () => {
    const when = new Date('2024-05-06T07:08:09.000Z');
    const entry = buildRegistryEntry({
      modelVersion: 'v1',
      metrics: { loss: 0.2 },
      registeredAt: when,
    });
    expect(entry.registeredAt).toBe('2024-05-06T07:08:09.000Z');
  });

  it('defaults registeredAt to a valid ISO-8601 timestamp when omitted', () => {
    const entry = buildRegistryEntry({
      modelVersion: 'v1',
      metrics: { accuracy: 0.5 },
    });
    expect(Number.isNaN(new Date(entry.registeredAt).getTime())).toBe(false);
  });

  it('rejects a missing or blank model version', () => {
    expect(() =>
      buildRegistryEntry({ modelVersion: '', metrics: { a: 1 } }),
    ).toThrow(RegistryEntryError);
    expect(() =>
      buildRegistryEntry({
        modelVersion: '   ',
        metrics: { a: 1 },
      }),
    ).toThrow(RegistryEntryError);
  });

  it('rejects non-finite or non-numeric metric values', () => {
    expect(() =>
      buildRegistryEntry({
        modelVersion: 'v1',
        metrics: { accuracy: Number.NaN },
      }),
    ).toThrow(RegistryEntryError);
    expect(() =>
      buildRegistryEntry({
        modelVersion: 'v1',
        metrics: { accuracy: Infinity },
      }),
    ).toThrow(RegistryEntryError);
    expect(() =>
      buildRegistryEntry({
        modelVersion: 'v1',
        metrics: { accuracy: 'high' as unknown as number },
      }),
    ).toThrow(RegistryEntryError);
  });

  it('rejects an invalid registeredAt timestamp', () => {
    expect(() =>
      buildRegistryEntry({
        modelVersion: 'v1',
        metrics: { a: 1 },
        registeredAt: 'not-a-date',
      }),
    ).toThrow(RegistryEntryError);
  });
});
