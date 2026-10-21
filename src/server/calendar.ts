import { Router } from 'express';
import { ownerGate } from './owner.js';
import { Firestore } from '@google-cloud/firestore';

/** Released value attached by the morning job (stage 6b). Always carries its source and fetch time. */
export interface EventValue {
  /** Code-fixed macro catalog id (src/server/macro/catalog.ts). */
  indicatorId: string;
  label: string;
  /** Decimal string exactly as the provider delivered it. */
  actual: string;
  previous: string | null;
  unit: string;
  /** First calendar day of the observation period the value belongs to. */
  period: string;
  previousPeriod: string | null;
  source: string;
  /** When the job received the value (UTC ISO). */
  observedAt: string;
}
/** AI text attached by the morning job; absent or null when the AI step is off or failed. */
export interface EventAiSummary {
  text: string;
  model: string;
  generatedAt: string;
}
export interface EventTranslation {
  model: string;
  translatedAt: string;
}
/** What the release decided or showed, as short Korean facts (src/server/calendar-enrich.ts). */
export interface EventOutcome {
  /** One Korean sentence, at most 60 characters. */
  headline: string;
  /** At most 8. Numbers come from the source title or an official API, never from a guess. */
  facts: { label: string; value: string; note?: string }[];
}
export const REACTION_ASSETS = [
  'KOSPI',
  'KOSDAQ',
  'KR_BOND_3Y',
  'KR_BOND_10Y',
  'USDKRW',
  'SPY',
] as const;
export type ReactionAsset = (typeof REACTION_ASSETS)[number];
export const REACTION_UNITS = ['%', '%p', '원'] as const;
/** Measured market move around the release; computed from official Toss data only (src/server/reaction.ts). */
export interface EventReaction {
  asset: ReactionAsset;
  /** Last close before the release. */
  from: { date: string; value: number };
  /** First close after the release. */
  to: { date: string; value: number };
  /** % for indices and SPY, %p for bond yields, 원 for USD/KRW. */
  change: number;
  unit: (typeof REACTION_UNITS)[number];
  /** USD/KRW only: the same move in percent. */
  changePercent?: number;
  source: string;
}
export interface EventImpact {
  asset: string;
  /** Mechanism and direction in at most 60 characters. */
  effect: string;
}
export const ENRICHED_FIELDS = ['title', 'outcome', 'impact', 'explainer'] as const;
/** Provenance of the AI-written parts. */
export interface EventEnrichment {
  model: string;
  generatedAt: string;
  version: number;
  /** Which of title/outcome/impact/explainer the model wrote. */
  aiFields: (typeof ENRICHED_FIELDS)[number][];
}
export interface EconomicEvent {
  id: number;
  eventKind?: 'scheduled' | 'news-release';
  date: string;
  /** HH:mm KST, or '' when the provider gives no release time (shown as "발표 시각 미확인"). */
  time: string;
  /** Catalog indicators whose released values belong to this event (morning job attaches them). */
  indicatorIds?: string[];
  values?: EventValue[];
  /** null = the AI step ran (or was disabled) and there is no summary; undefined = never processed. */
  aiSummary?: EventAiSummary | null;
  /** Exact provider title when `title` differs from it (Korean translation or cleaned text). */
  titleOriginal?: string;
  /** Present when `title` is an AI translation of `titleOriginal`. */
  translation?: EventTranslation;
  /** Leading release-type tag of the source title ("보도자료"), split off the title. */
  releaseType?: string;
  outcome?: EventOutcome;
  reaction?: EventReaction[];
  impact?: EventImpact[];
  /** At most two Korean sentences, only for hard concepts. */
  explainer?: string;
  enrichment?: EventEnrichment;
  title: string;
  country: '한국' | '미국' | '글로벌';
  category: string;
  assets: string[];
  importance: 1 | 2 | 3;
  forecast?: string;
  previous?: string;
  description: string;
  sourceUrl: string;
  sourceName: string;
  impactDirection: 'mixed' | 'up' | 'down' | 'unknown';
  impactHorizon: string;
  confidence: 'low' | 'medium' | 'high';
  factualObservedAt: string;
}
export interface CalendarRepository {
  list(from: string, to: string): Promise<EconomicEvent[]>;
  upsert(events: EconomicEvent[], authorId: string): Promise<void>;
}
const maximumResults = 2000;
export class MemoryCalendarRepository implements CalendarRepository {
  private events = new Map<number, EconomicEvent>();
  async list(from: string, to: string) {
    return structuredClone(
      [...this.events.values()]
        .filter((item) => item.date >= from && item.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id - b.id)
        .slice(0, maximumResults + 1),
    );
  }
  async upsert(events: EconomicEvent[], _authorId: string) {
    for (const event of events) this.events.set(event.id, structuredClone(event));
  }
}
export class FirestoreCalendarRepository implements CalendarRepository {
  constructor(private db = new Firestore()) {}
  async list(from: string, to: string) {
    const snapshot = await this.db
      .collection('economicEvents')
      .where('date', '>=', from)
      .where('date', '<=', to)
      .orderBy('date')
      .limit(maximumResults + 1)
      .get();
    return snapshot.docs.map((doc) => doc.data() as EconomicEvent);
  }
  async upsert(events: EconomicEvent[], authorId: string) {
    const batch = this.db.batch();
    for (const event of events)
      batch.set(this.db.collection('economicEvents').doc(String(event.id)), {
        ...event,
        authorId,
        updatedAt: new Date().toISOString(),
      });
    await batch.commit();
  }
}
function realDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= '1900-01-01' &&
    value <= '2200-12-31' &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function text(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  );
}
export function cleanEvent(input: unknown): EconomicEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const item = input as Record<string, unknown>;
  if (
    item.eventKind !== undefined &&
    item.eventKind !== 'scheduled' &&
    item.eventKind !== 'news-release'
  )
    return null;
  if (
    !Number.isSafeInteger(item.id) ||
    Number(item.id) <= 0 ||
    !realDate(item.date) ||
    typeof item.time !== 'string' ||
    (item.time !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time))
  )
    return null;
  const extras = cleanExtras(item);
  if (extras === null) return null;
  if (
    !text(item.title, 300) ||
    !['한국', '미국', '글로벌'].includes(item.country as string) ||
    !text(item.category, 80) ||
    !text(item.description, 5000)
  )
    return null;
  if (
    !Array.isArray(item.assets) ||
    item.assets.length < 1 ||
    item.assets.length > 12 ||
    !item.assets.every((asset) => text(asset, 80)) ||
    new Set(item.assets).size !== item.assets.length
  )
    return null;
  if (
    ![1, 2, 3].includes(Number(item.importance)) ||
    typeof item.importance !== 'number' ||
    !text(item.sourceName, 200) ||
    !text(item.sourceUrl, 2000)
  )
    return null;
  try {
    const source = new URL(item.sourceUrl);
    if (source.protocol !== 'https:' || !source.hostname || source.username || source.password)
      return null;
  } catch {
    return null;
  }
  if (
    !['mixed', 'up', 'down', 'unknown'].includes(item.impactDirection as string) ||
    !text(item.impactHorizon, 200) ||
    !['low', 'medium', 'high'].includes(item.confidence as string)
  )
    return null;
  if (
    typeof item.factualObservedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      item.factualObservedAt,
    ) ||
    !Number.isFinite(Date.parse(item.factualObservedAt)) ||
    !realDate(item.factualObservedAt.slice(0, 10))
  )
    return null;
  if (
    (item.forecast !== undefined && !text(item.forecast, 200, true)) ||
    (item.previous !== undefined && !text(item.previous, 200, true))
  )
    return null;
  // Explicit projection excludes account identifiers and administrative metadata from reads.
  return {
    id: item.id as number,
    eventKind: item.eventKind === 'news-release' ? 'news-release' : 'scheduled',
    date: item.date,
    time: item.time,
    title: item.title,
    country: item.country as EconomicEvent['country'],
    category: item.category,
    assets: item.assets as string[],
    importance: item.importance as EconomicEvent['importance'],
    description: item.description,
    sourceUrl: item.sourceUrl,
    sourceName: item.sourceName,
    impactDirection: item.impactDirection as EconomicEvent['impactDirection'],
    impactHorizon: item.impactHorizon,
    confidence: item.confidence as EconomicEvent['confidence'],
    factualObservedAt: item.factualObservedAt,
    ...(item.forecast === undefined ? {} : { forecast: item.forecast as string }),
    ...(item.previous === undefined ? {} : { previous: item.previous as string }),
    ...extras,
  };
}
const isoInstant =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = (value: unknown): value is string =>
  typeof value === 'string' && isoInstant.test(value) && Number.isFinite(Date.parse(value));
const catalogToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d{1,20}(?:\.\d{1,12})?$/.test(value);
type Extras = Pick<
  EconomicEvent,
  | 'indicatorIds'
  | 'values'
  | 'aiSummary'
  | 'titleOriginal'
  | 'translation'
  | 'releaseType'
  | 'outcome'
  | 'reaction'
  | 'impact'
  | 'explainer'
  | 'enrichment'
>;
/** Stored display text: bounded, no control characters, no markup, no links. */
const display = (value: unknown, max: number, allowEmpty = false): value is string =>
  text(value, max, allowEmpty) &&
  !/<[^>]*>|https?:|www\.|javascript:|data:/i.test(value) &&
  value === value.trim();
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const dated = (value: unknown): value is { date: string; value: number } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return realDate(row.date) && finite(row.value) && Math.abs(row.value) < 1e9;
};
function cleanOutcome(value: unknown): EventOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!display(raw.headline, 60) || !Array.isArray(raw.facts) || raw.facts.length > 8) return null;
  const facts: EventOutcome['facts'] = [];
  for (const entry of raw.facts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const fact = entry as Record<string, unknown>;
    if (
      !display(fact.label, 40) ||
      !display(fact.value, 80) ||
      (fact.note !== undefined && !display(fact.note, 120))
    )
      return null;
    facts.push({
      label: fact.label,
      value: fact.value,
      ...(fact.note === undefined ? {} : { note: fact.note as string }),
    });
  }
  return { headline: raw.headline, facts };
}
function cleanReaction(value: unknown): EventReaction[] | null {
  if (!Array.isArray(value) || value.length > REACTION_ASSETS.length) return null;
  const rows: EventReaction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (
      !REACTION_ASSETS.includes(row.asset as ReactionAsset) ||
      !dated(row.from) ||
      !dated(row.to) ||
      !finite(row.change) ||
      Math.abs(row.change) > 1e6 ||
      !REACTION_UNITS.includes(row.unit as (typeof REACTION_UNITS)[number]) ||
      (row.changePercent !== undefined &&
        (!finite(row.changePercent) || Math.abs(row.changePercent) > 1e4)) ||
      !display(row.source, 80)
    )
      return null;
    rows.push({
      asset: row.asset as ReactionAsset,
      from: { date: row.from.date, value: row.from.value },
      to: { date: row.to.date, value: row.to.value },
      change: row.change,
      unit: row.unit as EventReaction['unit'],
      ...(row.changePercent === undefined ? {} : { changePercent: row.changePercent as number }),
      source: row.source,
    });
  }
  if (new Set(rows.map((row) => row.asset)).size !== rows.length) return null;
  return rows;
}
function cleanImpact(value: unknown): EventImpact[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const rows: EventImpact[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!display(row.asset, 30) || !display(row.effect, 60)) return null;
    rows.push({ asset: row.asset, effect: row.effect });
  }
  return rows;
}
function cleanEnrichment(value: unknown): EventEnrichment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !display(raw.model, 100) ||
    !instant(raw.generatedAt) ||
    !Number.isInteger(raw.version) ||
    (raw.version as number) < 1 ||
    (raw.version as number) > 99 ||
    !Array.isArray(raw.aiFields) ||
    raw.aiFields.length > ENRICHED_FIELDS.length ||
    !raw.aiFields.every((field) => ENRICHED_FIELDS.includes(field)) ||
    new Set(raw.aiFields).size !== raw.aiFields.length
  )
    return null;
  return {
    model: raw.model,
    generatedAt: raw.generatedAt,
    version: raw.version as number,
    aiFields: raw.aiFields as EventEnrichment['aiFields'],
  };
}
/** Validates the optional morning-job fields; null means "reject the whole event". */
function cleanExtras(item: Record<string, unknown>): Extras | null {
  const extras: Extras = {};
  if (item.indicatorIds !== undefined) {
    const ids = item.indicatorIds;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 8 ||
      !ids.every(catalogToken) ||
      new Set(ids).size !== ids.length
    )
      return null;
    extras.indicatorIds = ids as string[];
  }
  if (item.values !== undefined) {
    const rows = item.values;
    if (!Array.isArray(rows) || rows.length > 8) return null;
    const values: EventValue[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      if (
        !catalogToken(row.indicatorId) ||
        !text(row.label, 120) ||
        !decimal(row.actual) ||
        !(row.previous === null || decimal(row.previous)) ||
        !text(row.unit, 80, true) ||
        !realDate(row.period) ||
        !(row.previousPeriod === null || realDate(row.previousPeriod)) ||
        !text(row.source, 80) ||
        !instant(row.observedAt)
      )
        return null;
      values.push({
        indicatorId: row.indicatorId,
        label: row.label,
        actual: row.actual,
        previous: row.previous as string | null,
        unit: row.unit as string,
        period: row.period,
        previousPeriod: row.previousPeriod as string | null,
        source: row.source,
        observedAt: row.observedAt,
      });
    }
    if (new Set(values.map((value) => value.indicatorId)).size !== values.length) return null;
    extras.values = values;
  }
  if (item.aiSummary !== undefined) {
    if (item.aiSummary === null) extras.aiSummary = null;
    else {
      const summary = item.aiSummary as Record<string, unknown>;
      if (
        typeof summary !== 'object' ||
        Array.isArray(summary) ||
        !text(summary.text, 1200) ||
        !text(summary.model, 100) ||
        !instant(summary.generatedAt)
      )
        return null;
      extras.aiSummary = {
        text: summary.text,
        model: summary.model,
        generatedAt: summary.generatedAt,
      };
    }
  }
  // The exact provider title may be kept without a translation (cleaned text); a translation always
  // needs the original it translated.
  if (item.titleOriginal !== undefined) {
    if (!text(item.titleOriginal, 300)) return null;
    extras.titleOriginal = item.titleOriginal;
  }
  if (item.translation !== undefined) {
    const translation = item.translation as Record<string, unknown> | null;
    if (
      item.titleOriginal === undefined ||
      !translation ||
      typeof translation !== 'object' ||
      Array.isArray(translation) ||
      !text(translation.model, 100) ||
      !instant(translation.translatedAt)
    )
      return null;
    extras.translation = { model: translation.model, translatedAt: translation.translatedAt };
  }
  if (item.releaseType !== undefined) {
    if (!display(item.releaseType, 40)) return null;
    extras.releaseType = item.releaseType;
  }
  if (item.outcome !== undefined) {
    const outcome = cleanOutcome(item.outcome);
    if (!outcome) return null;
    extras.outcome = outcome;
  }
  if (item.reaction !== undefined) {
    const reaction = cleanReaction(item.reaction);
    if (!reaction) return null;
    extras.reaction = reaction;
  }
  if (item.impact !== undefined) {
    const impact = cleanImpact(item.impact);
    if (!impact) return null;
    extras.impact = impact;
  }
  if (item.explainer !== undefined) {
    if (!display(item.explainer, 300)) return null;
    extras.explainer = item.explainer;
  }
  if (item.enrichment !== undefined) {
    const enrichment = cleanEnrichment(item.enrichment);
    if (!enrichment) return null;
    extras.enrichment = enrichment;
  }
  return extras;
}
export function createCalendarRouter({
  repository,
  ownerUserId,
}: {
  repository: CalendarRepository;
  ownerUserId?: string;
}) {
  const router = Router();
  router.use(['/api/calendar/events', '/api/admin/calendar/events'], (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } });
      return;
    }
    next();
  });
  // Calendar data is owner-only; re-checked here so it never relies on mount order alone.
  router.use(['/api/calendar/events', '/api/admin/calendar/events'], ownerGate(ownerUserId));
  router.get('/api/calendar/events', async (req, res) => {
    const { from, to, importance, category, asset, market } = req.query;
    if (
      !realDate(from) ||
      !realDate(to) ||
      from > to ||
      (Date.parse(to) - Date.parse(from)) / 86400000 > 366 ||
      (importance !== undefined && !['1', '2', '3'].includes(String(importance))) ||
      (category !== undefined && !text(category, 80)) ||
      (asset !== undefined && !text(asset, 80)) ||
      (market !== undefined && !['한국', '미국', '글로벌'].includes(String(market))) ||
      Object.values(req.query).some((value) => typeof value !== 'string')
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_CALENDAR_QUERY',
          message: '날짜 범위(최대366일)와 필터를 확인하세요.',
        },
      });
      return;
    }
    const records = await repository.list(from, to);
    const events = records
      .slice(0, maximumResults)
      .map(cleanEvent)
      .filter((event): event is EconomicEvent => event !== null)
      .filter(
        (event) =>
          (!importance || event.importance === Number(importance)) &&
          (!category || event.category === category) &&
          (!asset || event.assets.includes(asset as string)) &&
          (!market || event.country === market),
      );
    res.json({
      events,
      source: 'admin-curated',
      truncated: records.length > maximumResults,
      limit: maximumResults,
    });
  });
  router.post('/api/admin/calendar/events', async (req, res) => {
    if (res.locals.user.role !== 'admin') {
      res
        .status(403)
        .json({ error: { code: 'ADMIN_REQUIRED', message: '관리자 권한이 필요합니다.' } });
      return;
    }
    const inputs = req.body?.events;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
      res
        .status(400)
        .json({ error: { code: 'INVALID_EVENTS', message: '1~100개의 일정을 입력하세요.' } });
      return;
    }
    const events = inputs.map(cleanEvent);
    if (
      events.some((event) => event === null) ||
      new Set(events.map((event) => event?.id)).size !== events.length
    ) {
      res.status(400).json({
        error: { code: 'INVALID_EVENTS', message: '일정 필드·출처·중복 ID를 확인하세요.' },
      });
      return;
    }
    await repository.upsert(events as EconomicEvent[], res.locals.user.id);
    res.status(200).json({ imported: events.length });
  });
  return router;
}
