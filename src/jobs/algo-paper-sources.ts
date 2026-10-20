import type { Firestore } from '@google-cloud/firestore';
import type { InvestorFlowDay } from '../lib/algo';
import { snapshotDocumentId, type SnapshotDocument } from '../server/snapshots.js';

/**
 * Stored investor flows (stage 4 daily snapshots) for the supply signal. Only dates that were
 * actually stored are returned; a missing day is a missing day, never zero.
 */
export interface SupplySource {
  load(market: 'KR' | 'US', symbol: string, dates: string[]): Promise<InvestorFlowDay[]>;
}

const finiteNumber = (value: unknown): number | null => {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Reads the `investorTrading` section value written by the snapshot job. */
export function flowFromSection(date: string, section: unknown): InvestorFlowDay | null {
  if (!section || typeof section !== 'object') return null;
  const value = (section as { value?: unknown }).value;
  if (!value || typeof value !== 'object') return null;
  const v = value as {
    foreigner?: { netBuyVolume?: unknown };
    institution?: { netBuyVolume?: unknown };
  };
  const foreignerNet = finiteNumber(v.foreigner?.netBuyVolume);
  const institutionNet = finiteNumber(v.institution?.netBuyVolume);
  if (foreignerNet === null || institutionNet === null) return null;
  return { date, foreignerNet, institutionNet };
}

export class FirestoreSupplySource implements SupplySource {
  constructor(private db: Firestore) {}
  async load(market: 'KR' | 'US', symbol: string, dates: string[]) {
    if (market !== 'KR' || dates.length === 0) return [];
    const refs = dates.map((date) =>
      this.db.collection('marketSnapshots').doc(snapshotDocumentId('stock', market, date, symbol)),
    );
    const snapshots = await this.db.getAll(...refs);
    const out: InvestorFlowDay[] = [];
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      const flow = flowFromSection(dates[index], snapshot.data()?.investorTrading);
      if (flow) out.push(flow);
    });
    return out;
  }
}

/** For tests and local runs: reads documents held by a MemorySnapshotRepository. */
export class MemorySupplySource implements SupplySource {
  constructor(private documents: Map<string, SnapshotDocument>) {}
  async load(market: 'KR' | 'US', symbol: string, dates: string[]) {
    if (market !== 'KR') return [];
    const out: InvestorFlowDay[] = [];
    for (const date of dates) {
      const document = this.documents.get(snapshotDocumentId('stock', market, date, symbol));
      const flow = flowFromSection(date, document?.sections.investorTrading);
      if (flow) out.push(flow);
    }
    return out;
  }
}
