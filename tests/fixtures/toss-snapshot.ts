// Synthetic responses shaped like Toss Securities OpenAPI v1.2.24 (checked 2026-10-21 KST) for the
// stage 4 snapshot endpoints. Values are invented for tests; they are not real market data and not
// evidence that the live API behaves this way.
export const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  accountSeq: '1',
  ownerUserId: 'owner-fixture',
};
export const tokenResponse = () =>
  Response.json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 86400 });
export const ok = (result: unknown) => Response.json({ result });
export const providerError = (status: number, code: string, headers?: Record<string, string>) =>
  Response.json(
    {
      error: { requestId: 'req-fixture', code, message: 'raw provider text must never be logged' },
    },
    { status, headers },
  );
const session = (start: string, end: string) => ({ startTime: start, endTime: end });
/** KR calendar day: integrated (KRX+NXT) regular session, or a holiday when `regular` is null. */
export const krDay = (date: string, regular: [string, string] | null = null) => ({
  date,
  integrated: regular
    ? {
        preMarket: null,
        regularMarket: session(regular[0], regular[1]),
        afterMarket: null,
      }
    : null,
});
export const usDay = (date: string, regular: [string, string] | null = null) => ({
  date,
  dayMarket: null,
  preMarket: null,
  regularMarket: regular ? session(regular[0], regular[1]) : null,
  afterMarket: null,
});
export const krRegular = (date: string): [string, string] => [
  `${date}T09:00:00+09:00`,
  `${date}T15:30:00+09:00`,
];
export const flow = (buy: number, sell: number) => ({
  buyVolume: String(buy),
  sellVolume: String(sell),
  netBuyVolume: String(buy - sell),
});
export const investorRecord = (date: string, final = true) => ({
  date,
  updatedAt: `${date}T19:05:00+09:00`,
  individual: final ? flow(1000, 1200) : null,
  foreigner: flow(500, 300),
  institution: {
    ...flow(700, 600),
    breakdown: final
      ? {
          financialInvestment: flow(100, 100),
          insurance: flow(100, 100),
          trust: flow(100, 100),
          privateEquityFund: flow(100, 100),
          bank: flow(100, 100),
          otherFinancialInstitution: flow(100, 50),
          pensionFund: flow(100, 50),
        }
      : null,
  },
  otherCorporation: final ? flow(10, 10) : null,
  foreignerHolding: final
    ? { holdingQuantity: '12345', limitQuantity: '99999', holdingRate: '0.5089' }
    : null,
  cfd: null,
});
export const programRecord = (date: string) => ({
  date,
  arbitrage: flow(10, 5),
  nonArbitrage: flow(20, 30),
});
export const shortRecord = (date: string) => ({
  date,
  updatedAt: `${date}T19:00:00+09:00`,
  shortSellingVolume: '1500',
  shortSellingAmount: '99000000',
  shortSellingVolumeRate: '0.01234',
  shortSellingAmountRate: null,
});
const credit = () => ({
  newQuantity: '10',
  returnQuantity: '4',
  balanceQuantity: '600',
  balanceRate: '0.0042',
  tradingRate: '0.09',
});
export const creditRecord = (date: string) => ({
  date,
  updatedAt: `${date}T06:00:00+09:00`,
  marginLoan: credit(),
  stockLoan: null,
});
export const candleBar = (date: string, currency?: 'KRW' | 'USD', offset = '+09:00') => ({
  timestamp: `${date}T00:00:00${offset}`,
  openPrice: '100',
  highPrice: '110',
  lowPrice: '95',
  closePrice: '105',
  volume: '1000',
  ...(currency ? { currency } : {}),
});
/** Newest-first list of consecutive calendar days ending at `end`. */
export const datesBackFrom = (end: string, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().slice(0, 10);
  });
