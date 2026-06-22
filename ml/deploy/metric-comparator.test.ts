import {
  DEFAULT_OBJECTIVE_METRIC,
  ObjectiveMetricComparator,
} from './metric-comparator';

/**
 * ML-5 metric comparator (task 21.2 / Req 24.1, 24.3): the "compare metrics"
 * decision behind the deployer's promote/retain rule.
 */
describe('ObjectiveMetricComparator (R24.1, R24.3)', () => {
  it('defaults to the accuracy objective, higher-is-better', () => {
    expect(DEFAULT_OBJECTIVE_METRIC).toBe('accuracy');
    const cmp = new ObjectiveMetricComparator();
    expect(cmp.compare({ accuracy: 0.91 }, { accuracy: 0.9 })).toBe('better');
    expect(cmp.compare({ accuracy: 0.9 }, { accuracy: 0.91 })).toBe('not-better');
  });

  it('treats an exact tie as not-better (strict improvement required)', () => {
    const cmp = new ObjectiveMetricComparator();
    expect(cmp.compare({ accuracy: 0.9 }, { accuracy: 0.9 })).toBe('not-better');
  });

  it('reports incomparable when the objective metric is absent on either side', () => {
    const cmp = new ObjectiveMetricComparator();
    expect(cmp.compare({ f1: 0.9 }, { accuracy: 0.9 })).toBe('incomparable');
    expect(cmp.compare({ accuracy: 0.9 }, { f1: 0.9 })).toBe('incomparable');
  });

  it('reports incomparable for non-finite objective values', () => {
    const cmp = new ObjectiveMetricComparator();
    expect(cmp.compare({ accuracy: Number.NaN }, { accuracy: 0.9 })).toBe(
      'incomparable',
    );
    expect(cmp.compare({ accuracy: Infinity }, { accuracy: 0.9 })).toBe(
      'incomparable',
    );
  });

  it('compares a custom objective metric', () => {
    const cmp = new ObjectiveMetricComparator({ metric: 'f1' });
    expect(cmp.compare({ f1: 0.8 }, { f1: 0.7 })).toBe('better');
    expect(cmp.compare({ f1: 0.6 }, { f1: 0.7 })).toBe('not-better');
  });

  it('supports lower-is-better objectives (loss)', () => {
    const cmp = new ObjectiveMetricComparator({
      metric: 'loss',
      direction: 'lower-is-better',
    });
    expect(cmp.compare({ loss: 0.1 }, { loss: 0.2 })).toBe('better');
    expect(cmp.compare({ loss: 0.3 }, { loss: 0.2 })).toBe('not-better');
    expect(cmp.compare({ loss: 0.2 }, { loss: 0.2 })).toBe('not-better');
  });
});
