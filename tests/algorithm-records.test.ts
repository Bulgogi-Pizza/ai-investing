import { describe, expect, it } from 'vitest';
import {
  budgetRaised,
  diffAlgorithm,
  findLiveOverlap,
  inputFromTemplate,
  maxTargets,
  parseAlgorithmInput,
  parseCostSettings,
  validateTargets,
  type AlgorithmInput,
} from '../src/lib/algorithmRecords';

const base = (): AlgorithmInput => ({
  ...inputFromTemplate('momentum', 'KR'),
  name: '모멘텀 A',
  targets: ['005930', '000660'],
});

describe('algorithm input parsing', () => {
  it('accepts a template-based formula algorithm and normalizes symbols and name', () => {
    const parsed = parseAlgorithmInput({
      ...base(),
      name: '  모멘텀 A  ',
      targets: [' aapl'.trim(), '005930'],
      market: 'US',
      currency: 'USD',
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { name: '모멘텀 A', targets: ['AAPL', '005930'], market: 'US', budget: null },
    });
  });
  it('ignores unknown keys instead of storing them', () => {
    const parsed = parseAlgorithmInput({ ...base(), accountNumber: '1234', params: { x: 1 } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.value)).not.toContain('accountNumber');
  });
  it('rejects bad names, targets, modes and currency', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(61) }, 'name'],
      [{ name: 'a‮b' }, 'name'],
      [{ targets: [] }, 'targets'],
      [{ targets: ['../etc'] }, 'targets'],
      [{ targets: ['005930', '005930'] }, 'targets'],
      [{ targets: Array.from({ length: maxTargets + 1 }, (_, i) => `S${i}`) }, 'targets'],
      [{ targets: [5] }, 'targets'],
      [{ mode: 'turbo' }, 'mode'],
      [{ market: 'JP' }, 'market'],
      [{ currency: 'USD' }, 'currency'],
      [{ market: 'US', currency: 'KRW' }, 'currency'],
      [{ budget: -1 }, 'budget'],
      [{ budget: 1e13 }, 'budget'],
      [{ budget: 'abc' }, 'budget'],
      [{ method: 'magic' }, 'method'],
      [{ template: '__proto__' }, 'template'],
      [{ method: 'ai', mode: 'simulation' }, 'mode'],
    ];
    for (const [patch, field] of cases) {
      const parsed = parseAlgorithmInput({ ...base(), ...patch });
      expect(parsed.ok, JSON.stringify(patch)).toBe(false);
      if (!parsed.ok) expect(parsed.field, JSON.stringify(patch)).toBe(field);
    }
  });
  it('rejects bad signals and thresholds', () => {
    const bad = (patch: Record<string, unknown>) => parseAlgorithmInput({ ...base(), ...patch });
    expect(bad({ signals: [] }).ok).toBe(false);
    expect(bad({ signals: [{ id: 'astrology', weight: 1 }] }).ok).toBe(false);
    expect(bad({ signals: [{ id: 'trend', weight: 0 }] }).ok).toBe(false);
    expect(bad({ signals: [{ id: 'trend', weight: 2 }] }).ok).toBe(false);
    expect(
      bad({
        signals: [
          { id: 'trend', weight: 1 },
          { id: 'trend', weight: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(bad({ buyThreshold: 2 }).ok).toBe(false);
    expect(bad({ buyThreshold: 0.1, sellThreshold: 0.2 }).ok).toBe(false);
    expect(bad({ buyThreshold: Number.NaN }).ok).toBe(false);
  });
  it('validates dual momentum parameters against the target list', () => {
    const dual = { ...inputFromTemplate('dualMomentum', 'KR'), name: '듀얼', targets: ['A', 'B'] };
    expect(parseAlgorithmInput(dual).ok).toBe(true);
    expect(parseAlgorithmInput({ ...dual, dualMomentum: { lookbackDays: 5 } }).ok).toBe(false);
    expect(parseAlgorithmInput({ ...dual, dualMomentum: { topN: 3 } }).ok).toBe(false);
    expect(parseAlgorithmInput({ ...dual, dualMomentum: { lookbackDays: 126, topN: 2 } }).ok).toBe(
      true,
    );
  });
  it('validates targets with clear messages', () => {
    expect(validateTargets(['005930', 'AAPL'])).toBeNull();
    expect(validateTargets([])).toMatch('하나 이상');
    expect(validateTargets(['a b'])).toMatch('형식');
  });
});

describe('change history and risk rules', () => {
  it('describes what changed and detects budget increases', () => {
    const before = { ...base(), budget: 1_000_000, mode: 'simulation' as const };
    const after = {
      ...before,
      targets: ['005930', '035420'],
      budget: 2_000_000,
      mode: 'paper' as const,
      buyThreshold: 0.4,
    };
    const changes = diffAlgorithm(before, after);
    expect(changes.map((c) => c.field).sort()).toEqual(['budget', 'mode', 'targets', 'thresholds']);
    expect(changes.find((c) => c.field === 'targets')).toMatchObject({
      added: ['035420'],
      removed: ['000660'],
    });
    expect(diffAlgorithm(before, before)).toEqual([]);
    expect(budgetRaised(before, after)).toBe(true);
    expect(budgetRaised(after, before)).toBe(false);
    expect(budgetRaised({ ...before, budget: null }, after)).toBe(false);
  });
  it('flags only live algorithms that share a symbol, naming the conflicting one', () => {
    const others = [
      { id: '1', name: '실전 A', mode: 'live' as const, targets: ['005930'] },
      { id: '2', name: '모의 B', mode: 'paper' as const, targets: ['000660'] },
    ];
    expect(findLiveOverlap({ targets: ['005930', 'X'] }, others)).toEqual({
      name: '실전 A',
      symbols: ['005930'],
    });
    expect(findLiveOverlap({ targets: ['000660'] }, others)).toBeNull();
    expect(findLiveOverlap({ id: '1', targets: ['005930'] }, others)).toBeNull();
  });
});

describe('cost settings', () => {
  it('accepts empty (not set) values and rates, never defaults a legal rate', () => {
    expect(parseCostSettings({})).toMatchObject({
      ok: true,
      value: { commissionRate: null, sellTaxRate: null, capitalGainsTax: null },
    });
    expect(
      parseCostSettings({
        commissionRate: 0.00015,
        sellTaxRate: 0.0018,
        capitalGainsTax: { rate: 0.22, annualDeduction: 1800 },
      }).ok,
    ).toBe(true);
  });
  it('rejects out-of-range or malformed values (e.g. a percent typed as a fraction)', () => {
    expect(parseCostSettings({ commissionRate: 15 }).ok).toBe(false);
    expect(parseCostSettings({ sellTaxRate: -0.1 }).ok).toBe(false);
    expect(parseCostSettings({ capitalGainsTax: { rate: 0.2 } }).ok).toBe(false);
    expect(parseCostSettings({ capitalGainsTax: { rate: 0.2, annualDeduction: -1 } }).ok).toBe(
      false,
    );
    expect(parseCostSettings(null).ok).toBe(false);
  });
});
