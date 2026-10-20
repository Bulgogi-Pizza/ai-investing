export * from './types';
export {
  assertCompletedBars,
  clampScore,
  computeSignalScores,
  defaultSignalParams,
  meanReversionScore,
  momentumReturn,
  momentumScore,
  normalizeValueSnapshots,
  requiredBarsForSignal,
  trendScore,
  valueScore,
  type SignalInput,
} from './signals';
export {
  compositeScore,
  decideDualMomentum,
  decideFormula,
  type CompositeResult,
} from './composite';
export {
  createAlgorithm,
  defaultDualMomentumParams,
  requiredBars,
  templateDefaults,
  validateAlgorithm,
  type AlgorithmBase,
  type AlgorithmOverrides,
  type TemplateDefaults,
} from './templates';
export {
  checkOrder,
  defaultSafeguards,
  maxQuantityBelowValue,
  type OrderCheckInput,
  type OrderCheckResult,
  type OrderRejection,
  type Safeguards,
} from './safeguards';
export {
  capitalGainsTaxForYear,
  costWarnings,
  resolveCosts,
  roundTripCostRate,
  type CapitalGainsTaxSetting,
  type CostSettings,
  type ResolvedCosts,
} from './costs';
export {
  addSample,
  bucketIndex,
  buildBucketStats,
  createBucketStats,
  defaultBucketWidth,
  defaultMinSamples,
  expectedProfit,
  type BucketStat,
  type BucketStats,
  type ProfitSample,
} from './expectedProfit';
export { annualizedVolatility, dailyReturns, maxDrawdown, TRADING_DAYS_PER_YEAR } from './metrics';
export {
  runBacktest,
  type BacktestInput,
  type BacktestOptions,
  type BacktestResult,
  type DecisionRecord,
  type EquityPoint,
  type OpenPosition,
  type RoundTrip,
  type Trade,
} from './backtest';
export {
  createPaperLedger,
  heldTradingDays,
  maxPaperEquityPoints,
  maxPaperSamples,
  paperMetrics,
  runPaperDay,
  type ExternalDecision,
  type PaperDayInput,
  type PaperDayResult,
  type PaperDecisionRecord,
  type PaperEquityPoint,
  type PaperFill,
  type PaperLedger,
  type PaperMetrics,
  type PaperPosition,
  type PaperQuote,
  type PaperShadow,
} from './paper';
export {
  defaultSupplyParams,
  supplyScore,
  type InvestorFlowDay,
  type SupplyParams,
} from './supply';
