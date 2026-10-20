import { describe, expect, it } from 'vitest';
import {
  defensiveScenario,
  initialStrategy,
  rebalance,
  validateTargets,
} from '../src/lib/strategy';
describe('포트폴리오 전략', () => {
  it('범위, 유한값, 합계를 검증한다', () => {
    expect(validateTargets(initialStrategy.targets)).toBeNull();
    expect(validateTargets({ stock: 70, bond: 25, gold: 10, cash: 10 })).toBeTruthy();
    expect(validateTargets({ stock: NaN, bond: 25, gold: 10, cash: 10 })).toBeTruthy();
    expect(validateTargets({ stock: -1, bond: 81, gold: 10, cash: 10 })).toBeTruthy();
  });
  it('리밸런싱 제안 금액은 총자산을 보존한다', () => {
    const rows = rebalance(
      1000000,
      { stock: 65, bond: 15, gold: 10, cash: 10 },
      initialStrategy.targets,
    );
    expect(rows[0].amount).toBe(-100000);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(0);
  });
  it('음수 자산 및 잘못된 비중을 거절한다', () => {
    expect(() => rebalance(-1, initialStrategy.targets, initialStrategy.targets)).toThrow();
  });
  it('방어 시나리오는 비중 합계를 보존하고 주식 부족 시 제한한다', () => {
    expect(defensiveScenario(initialStrategy.targets)).toEqual({
      stock: 50,
      bond: 28,
      gold: 10,
      cash: 12,
    });
    const target = defensiveScenario({ stock: 2, bond: 78, gold: 10, cash: 10 });
    expect(target.stock).toBe(0);
    expect(validateTargets(target)).toBeNull();
  });
});

import { analyzeStrategy, parseStoredStrategy } from '../src/lib/strategy';
describe('계정 전략 및 기간별 규칙 분석', () => {
  it('저장 계약을 변환하고 비중 오류는 차단한다', () => {
    expect(
      parseStoredStrategy({
        targetAllocations: [{ asset: 'stock', percentage: 100 }],
        riskTolerance: 'low',
        horizon: '3',
        benchmark: 'KOSPI 200',
        notes: '분산 투자',
      })?.risk,
    ).toBe('conservative');
    expect(
      parseStoredStrategy({ targetAllocations: [{ asset: 'stock', percentage: 101 }] }),
    ).toBeNull();
  });
  it('기간별로 다른 관찰 창과 수익률을 계산한다', () => {
    const prices = Array.from({ length: 30 }, (_, index) => 100 + index);
    const day = analyzeStrategy(prices, initialStrategy, 'daily');
    const month = analyzeStrategy(prices, initialStrategy, 'monthly');
    expect(day.window).toBe(1);
    expect(month.window).toBe(20);
    expect(month.change).toBeGreaterThan(day.change);
    expect(month.action).not.toBe(day.action);
    expect(() => analyzeStrategy([0], initialStrategy, 'daily')).toThrow();
  });
});
