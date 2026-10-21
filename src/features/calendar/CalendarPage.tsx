import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Globe2,
  Plus,
  Settings2,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import {
  compareEventTime,
  importancePresentation,
  filterEvents,
  MarketEvent,
  startOfWeekDay,
  shiftCalendarDate,
  adjacentCalendarDate,
} from '../../lib/market';
import { DataState, LoadingState } from '../../components/DataState';
import { SourceLink } from '../../components/SourceLink';
import { EventEnrichmentDetail } from './EventEnrichmentDetail';
import { formatKst, kstToday } from '../../lib/kst';
import { ApiError, issueOf, signalAuthRequired, type DataIssue } from '../../lib/api';
import './calendar-morning.css';

/** Release time unknown (providers such as FRED publish dates only): shown instead of a time. */
const UNKNOWN_TIME = '발표 시각 미확인';
const timeText = (time: string) => time || UNKNOWN_TIME;
type Brief = { date: string; text: string; generatedAt: string; aiUsed: boolean };
const flag = (country: string) => (country === '한국' ? '🇰🇷' : country === '미국' ? '🇺🇸' : '🌐');
export default function CalendarPage({ search, isAdmin }: { search: string; isAdmin: boolean }) {
  const [view, setView] = useState('월간');
  const [newsSources, setNewsSources] = useState<
    { id: string; name: string; feedUrl: string; country: string; coverage: string }[]
  >([]);
  const [newsSourceWarnings, setNewsSourceWarnings] = useState<string[]>([]);
  const [newsError, setNewsError] = useState('');
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsSummary, setNewsSummary] = useState<{
    count: number;
    sources: { id: string; name: string; status: string; count: number }[];
    warnings: string[];
  } | null>(null);
  const newsRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    fetch('/api/news/sources', { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          signalAuthRequired(response.status, body.error?.code);
          throw new ApiError(
            response.status,
            body.error?.code ?? 'REQUEST_FAILED',
            body.error?.message ?? '공식 뉴스 출처를 불러오지 못했습니다.',
          );
        }
        if (!Array.isArray(body.sources)) throw new Error('뉴스 출처 응답을 확인하지 못했습니다.');
        if (!controller.signal.aborted) {
          setNewsSources(body.sources);
          setNewsSourceWarnings(Array.isArray(body.warnings) ? body.warnings : []);
        }
      })
      .catch((error) => {
        // Owner-only is reported once by the calendar request, not as a news error.
        if (!controller.signal.aborted && issueOf(error).kind !== 'owner-only')
          setNewsError(error instanceof Error ? error.message : '뉴스 출처 조회 실패');
      });
    return () => {
      controller.abort();
      newsRequest.current?.abort();
    };
  }, [isAdmin]);
  async function syncNews() {
    newsRequest.current?.abort();
    const controller = new AbortController();
    newsRequest.current = controller;
    setNewsLoading(true);
    setNewsError('');
    setNewsSummary(null);
    try {
      const response = await fetch('/api/admin/news/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(
          newsSources.length ? { sourceIds: newsSources.map((source) => source.id) } : {},
        ),
      });
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (
        Array.isArray(body.sources) &&
        Array.isArray(body.warnings) &&
        typeof body.count === 'number'
      )
        setNewsSummary({ count: body.count, sources: body.sources, warnings: body.warnings });
      if (!response.ok) throw new Error(body.error?.message ?? '공식 뉴스를 수집하지 못했습니다.');
      if (typeof body.count !== 'number' || body.count < 0)
        throw new Error('뉴스 수집 결과를 확인하지 못했습니다.');
      if (body.count > 0) {
        setCalendarReload((value) => value + 1);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setNewsError(error instanceof Error ? error.message : '뉴스 수집에 실패했습니다.');
    } finally {
      if (!controller.signal.aborted) setNewsLoading(false);
    }
  }

  const [registered, setRegistered] = useState<MarketEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarIssue, setCalendarIssue] = useState<DataIssue | null>(null);
  const [calendarTruncated, setCalendarTruncated] = useState(false);
  const [calendarReload, setCalendarReload] = useState(0);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefState, setBriefState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [shownOriginals, setShownOriginals] = useState<number[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setBriefState('loading');
    fetch('/api/calendar/brief', { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error('brief');
        const item = body?.brief;
        if (item === null) return { brief: null };
        if (
          typeof item?.date !== 'string' ||
          typeof item?.text !== 'string' ||
          typeof item?.generatedAt !== 'string'
        )
          throw new Error('brief');
        return { brief: item as Brief };
      })
      .then(({ brief: item }) => {
        if (controller.signal.aborted) return;
        setBrief(item);
        setBriefState(item ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!controller.signal.aborted) setBriefState('error');
      });
    return () => controller.abort();
  }, [calendarReload]);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const today = kstToday();
  const [month, setMonth] = useState(today.month);
  const [year, setYear] = useState(today.year);
  const [importance, setImportance] = useState('전체 중요도');
  const [category, setCategory] = useState('전체 카테고리');
  const [asset, setAsset] = useState('전체 자산');
  const [market, setMarket] = useState('전체 시장');
  const [selected, setSelected] = useState<MarketEvent | null>(null);
  const [saved, setSaved] = useState<number[]>([]);
  const [day, setDay] = useState(today.day);
  useEffect(
    () => setSelected(null),
    [month, year, day, importance, category, asset, market, search],
  );
  useEffect(() => {
    setRegistered([]);
    setCalendarIssue(null);
    setCalendarTruncated(false);
    const controller = new AbortController();
    setCalendarLoading(true);
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const from = iso(new Date(year, month, -6));
    const to = iso(new Date(year, month + 1, 7));
    fetch(`/api/calendar/events?from=${from}&to=${to}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          signalAuthRequired(response.status, body?.error?.code);
          throw new ApiError(
            response.status,
            body?.error?.code ?? 'REQUEST_FAILED',
            body?.error?.message ?? '등록 일정을 불러오지 못했습니다.',
          );
        }
        if (!Array.isArray(body.events)) throw new Error('일정 응답을 확인하지 못했습니다.');
        const mapped = body.events.map(
          (event: MarketEvent & { date: string; assets: string[] }) => {
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
              !Array.isArray(event.assets) ||
              !event.assets.length ||
              !event.sourceName ||
              !event.sourceUrl
            )
              throw new Error('일정 출처 또는 날짜가 올바르지 않습니다.');
            return {
              ...event,
              day: Number(event.date.slice(8)),
              asset: event.assets[0],
              forecast: event.forecast ?? '—',
              previous: event.previous ?? '—',
            };
          },
        );
        if (!controller.signal.aborted) {
          setRegistered(mapped);
          setCalendarTruncated(body.truncated === true);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCalendarIssue(issueOf(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCalendarLoading(false);
      });
    return () => controller.abort();
  }, [year, month, calendarReload]);
  async function importEvents(e: React.FormEvent) {
    e.preventDefault();
    setImportError('');
    setImportLoading(true);
    try {
      const body = JSON.parse(importJson);
      if (!body || !Array.isArray(body.events) || !body.events.length)
        throw new Error('events 배열에 최소 한 개의 일정을 입력하세요.');
      const response = await fetch('/api/admin/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(failure.error?.message ?? '일정을 등록하지 못했습니다.');
      }
      setImportOpen(false);
      setImportJson('');
      setCalendarReload((v) => v + 1);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'JSON 또는 연결을 확인해 주세요.');
    } finally {
      setImportLoading(false);
    }
  }
  const todayIso = `${today.year}-${String(today.month + 1).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  const todayWeekday = ['일', '월', '화', '수', '목', '금', '토'][
    new Date(today.year, today.month, today.day).getDay()
  ];
  const weekStart = startOfWeekDay(year, month, day);
  const firstWeekDate = adjacentCalendarDate(year, month, weekStart);
  const lastWeekDate = adjacentCalendarDate(year, month, weekStart + 6);
  const dataset = registered;
  const filtered = filterEvents(dataset, {
    importance: importance === '전체 중요도' ? undefined : Number(importance),
    category: category === '전체 카테고리' ? undefined : category,
    asset: asset === '전체 자산' ? undefined : asset,
    country: market === '전체 시장' ? undefined : market,
    search,
  });
  const isTodayMonth = year === today.year && month === today.month;
  const monthEvents = filtered.filter((event) =>
    event.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`),
  );
  const days = new Date(year, month + 1, 0).getDate();
  const offset = new Date(year, month, 1).getDay();
  const cells = Array.from(
    { length: Math.ceil((days + offset) / 7) * 7 },
    (_, i) => i - offset + 1,
  );
  const agendaEvents =
    view === '주간'
      ? filtered.filter((e) => {
          const stamp = new Date(`${e.date}T00:00:00`).getTime();
          return (
            stamp >= new Date(year, month, weekStart).getTime() &&
            stamp <= new Date(year, month, weekStart + 6).getTime()
          );
        })
      : monthEvents.filter((e) => e.day === day);
  const detailEvents = view === '주간' ? agendaEvents : monthEvents;
  const selectedEvent =
    detailEvents.find((e) => e.id === selected?.id) ??
    detailEvents.find((e) => e.day >= day) ??
    detailEvents[0] ??
    null;
  function move(n: number) {
    if (view === '월간') {
      const date = new Date(year, month + n, 1);
      setMonth(date.getMonth());
      setYear(date.getFullYear());
      setDay(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
    } else {
      const next = shiftCalendarDate(year, month, day, n * (view === '주간' ? 7 : 1));
      setYear(next.year);
      setMonth(next.month);
      setDay(next.day);
    }
  }
  function reset() {
    setImportance('전체 중요도');
    setCategory('전체 카테고리');
    setAsset('전체 자산');
    setMarket('전체 시장');
  }
  if (calendarIssue?.kind === 'owner-only')
    return (
      <>
        <div className="page-heading">
          <div className="eyebrow">MARKET INTELLIGENCE</div>
          <h1>
            경제 캘린더
            <span className="title-dot" />
          </h1>
        </div>
        <DataState issue={calendarIssue} />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">MARKET INTELLIGENCE</div>
        <div className="title-row">
          <div>
            <h1>
              경제 캘린더
              <span className="title-dot" />
            </h1>
            <p>시장의 흐름을 바꾸는 주요 일정, 한눈에 확인하세요.</p>
          </div>
          <button
            className="button"
            onClick={() => {
              const now = kstToday();
              setYear(now.year);
              setMonth(now.month);
              setDay(now.day);
              setSelected(null);
            }}
          >
            <CalendarDays size={15} /> 오늘로 이동
          </button>
        </div>
      </div>
      <section className="morning-brief" data-state={briefState} aria-label="아침 브리핑">
        <strong>
          <Sparkles size={14} /> 아침 브리핑
        </strong>
        {briefState === 'loading' && <p>불러오는 중입니다.</p>}
        {briefState === 'error' && <p>아침 브리핑을 불러오지 못했습니다.</p>}
        {briefState === 'empty' && (
          <p>아직 저장된 브리핑이 없습니다. 아침 작업(매일 07:00 KST)이 실행되면 표시됩니다.</p>
        )}
        {briefState === 'ready' && brief && (
          <>
            <p>{brief.text}</p>
            <small>
              {formatKst(brief.generatedAt)} KST 생성{brief.aiUsed ? ' · AI 요약 포함' : ''}
            </small>
          </>
        )}
      </section>
      <div className="calendar-stats">
        <div>
          <span className="stat-icon purple">
            <CalendarDays size={19} />
          </span>
          <span>
            <small>이번 달 주요 일정</small>
            <strong>
              {monthEvents.length}
              <em>개</em>
            </strong>
          </span>
          <span className="stat-foot">등록된 경제 이벤트</span>
        </div>
        <div>
          <span className="stat-icon red">
            <Activity size={19} />
          </span>
          <span>
            <small>주목해야 할 일정</small>
            <strong>
              {monthEvents.filter((e) => e.importance === 3).length}
              <em>개</em>
            </strong>
          </span>
          <span className="stat-foot">
            <i className="importance-dot high" /> 높은 중요도
          </span>
        </div>
        <div>
          <span className="stat-icon blue">
            <Globe2 size={19} />
          </span>
          <span>
            <small>오늘의 주요 일정</small>
            <strong>
              {dataset.filter((e) => e.date === todayIso).length}
              <em>개</em>
            </strong>
          </span>
          <span className="stat-foot">
            {today.month + 1}월 {today.day}일 {todayWeekday}요일
          </span>
        </div>
      </div>
      <div className="calendar-source-toolbar">
        <span>
          출처를 포함한 등록 일정과 공식 발표 뉴스입니다. 뉴스의 날짜는 발표 시각 기준입니다.
        </span>
        {isAdmin && (
          <button
            className="button small"
            onClick={() => {
              setImportError('');
              setImportOpen(true);
            }}
          >
            <Plus size={13} /> 일정 JSON 등록
          </button>
        )}
      </div>
      {isAdmin && (
        <section
          className="detail-card"
          style={{ marginBottom: 15 }}
          aria-label="공식 뉴스 수집 관리"
        >
          <div className="card-heading">
            <h3>공식 발표 뉴스</h3>
            <button className="button small" disabled={newsLoading} onClick={() => void syncNews()}>
              {newsLoading ? '공식 뉴스 수집 중…' : '공식 뉴스 수집'}
            </button>
          </div>
          <p className="subtle">
            발표 시각 기준 뉴스입니다. 미래 경제 일정이 아니며 분류·중요도·영향 자산은 규칙으로
            추정합니다. 전체 시장 뉴스를 포함하지 않습니다.
          </p>
          {newsSources.length > 0 && (
            <div className="tag-row">
              {newsSources.map((source) => (
                <SourceLink
                  key={source.id}
                  url={source.feedUrl}
                  title={source.coverage}
                  style={{ fontSize: 9, color: '#806aab' }}
                >
                  {source.name} ↗
                </SourceLink>
              ))}
            </div>
          )}
          {newsSourceWarnings.map((warning, index) => (
            <p key={index} className="subtle">
              {warning}
            </p>
          ))}
          {newsLoading && (
            <p role="status" className="subtle">
              공식 RSS 출처를 확인하고 있습니다.
            </p>
          )}
          {newsError && (
            <div role="alert" className="form-error">
              {newsError}
            </div>
          )}
          {newsSummary && (
            <div className="news-sync-summary" role="status">
              <p className="subtle">
                추가·갱신 {newsSummary.count}건 · 동일 뉴스 재수집은 신규 기사 수가 아닙니다.
              </p>
              {newsSummary.sources.map((source) => (
                <p key={source.id} className="subtle">
                  {source.name} ·{' '}
                  {source.status === 'failed'
                    ? '수집 실패'
                    : source.status === 'cached'
                      ? '캐시 사용'
                      : '수집 완료'}{' '}
                  · {source.count}건
                </p>
              ))}
              {newsSummary.warnings.map((warning, index) => (
                <p key={index} className="subtle">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
      {calendarLoading && <LoadingState label="등록 일정을 불러오는 중…" />}
      {calendarIssue && (
        <DataState issue={calendarIssue} onRetry={() => setCalendarReload((v) => v + 1)} />
      )}
      {!calendarLoading && !calendarIssue && registered.length === 0 && (
        <DataState
          issue={{
            kind: 'no-data',
            message:
              '이 기간에 등록된 일정이 없습니다. 기간을 이동하거나 관리자가 일정을 등록해야 합니다.',
            retryable: true,
          }}
          title="등록된 일정이 없습니다"
        />
      )}
      {calendarTruncated && (
        <div className="data-notice" role="status">
          일정 조회 한도를 초과해 일부 일정만 표시됩니다. 전체 일정 수가 아니므로 기간을 좁혀 확인해
          주세요.
        </div>
      )}
      <section className="calendar-card">
        <div className="calendar-toolbar">
          <div className="month-heading">
            <h2>
              {year}년 {month + 1}월
            </h2>
            <div className="month-navigation">
              <button aria-label="이전 기간" onClick={() => move(-1)}>
                <ChevronLeft size={17} />
              </button>
              <button aria-label="다음 기간" onClick={() => move(1)}>
                <ChevronRight size={17} />
              </button>
            </div>
            <button
              className="today-btn"
              onClick={() => {
                const now = kstToday();
                setYear(now.year);
                setMonth(now.month);
                setDay(now.day);
              }}
            >
              오늘
            </button>
          </div>
          <div className="view-toggle">
            {['월간', '주간', '일간', '시간별'].map((v) => (
              <button className={view === v ? 'selected' : ''} onClick={() => setView(v)} key={v}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="filterbar">
          <Settings2 size={16} />
          {[
            [importance, setImportance, ['전체 중요도', '3', '2', '1']],
            [
              category,
              setCategory,
              [
                '전체 카테고리',
                ...new Set([
                  '통화정책',
                  '물가',
                  '고용',
                  '경기',
                  '에너지',
                  ...dataset.map((e) => e.category),
                ]),
              ],
            ],
            [
              asset,
              setAsset,
              [
                '전체 자산',
                ...new Set([
                  '유가',
                  '금리',
                  '원화',
                  '달러',
                  '금',
                  '채권',
                  ...dataset.flatMap((e) => e.assets),
                ]),
              ],
            ],
            [market, setMarket, ['전체 시장', '한국', '미국', '글로벌']],
          ].map(([value, set, options], i) => (
            <label key={i} className="select-wrap">
              <select
                aria-label={['중요도 필터', '카테고리 필터', '자산 필터', '시장 필터'][i]}
                value={value as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
              >
                {(options as string[]).map((o) => (
                  <option key={o} value={o}>
                    {i === 0 && o !== '전체 중요도'
                      ? o === '3'
                        ? '높음'
                        : o === '2'
                          ? '보통'
                          : '낮음'
                      : o}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
          ))}
          <button className="reset-filter" onClick={reset}>
            초기화
          </button>
          <span className="timezone">KST · 한국 표준시</span>
        </div>
        {view === '월간' ? (
          <div className="month-grid">
            <div className="weekdays">
              {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {cells.map((d, i) => (
                <div
                  key={i}
                  className={`calendar-day ${d < 1 || d > days ? 'muted-day' : ''} ${isTodayMonth && d === today.day ? 'current-day' : ''}`}
                >
                  <button
                    className="day-number"
                    disabled={d < 1 || d > days}
                    aria-label={
                      d < 1 || d > days ? '이전 또는 다음 달' : `${month + 1}월 ${d}일 일정`
                    }
                    onClick={() => {
                      if (d > 0 && d <= days) {
                        setDay(d);
                        setView('일간');
                      }
                    }}
                  >
                    {d < 1 ? new Date(year, month, 0).getDate() + d : d > days ? d - days : d}
                    {isTodayMonth && d === today.day && <span>오늘</span>}
                  </button>
                  {monthEvents
                    .filter((e) => e.day === d)
                    .map((e) => (
                      <button
                        key={e.id}
                        onClick={() => setSelected(e)}
                        className={`event-chip event-${importancePresentation(e.importance).tone} ${selected?.id === e.id ? 'event-selected' : ''}`}
                        style={
                          e.importance === 1
                            ? {
                                background: '#eff4fb',
                                borderLeftColor: '#a7bddb',
                                color: '#637fa5',
                              }
                            : undefined
                        }
                      >
                        <span className="event-time">
                          {e.time ? e.time : '시각 미확인'}
                          <i
                            className={`importance-dot ${importancePresentation(e.importance).tone}`}
                          />
                        </span>
                        <span className="event-name">
                          {flag(e.country)} {e.title}
                        </span>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="agenda">
            <div className="agenda-heading">
              {view === '주간'
                ? `${firstWeekDate.month + 1}월 ${firstWeekDate.day}일 – ${lastWeekDate.month + 1}월 ${lastWeekDate.day}일`
                : `${month + 1}월 ${day}일`}
              <span>{view === '시간별' ? '시간 순 타임라인' : '경제 이벤트'}</span>
            </div>
            {view === '시간별' ? (
              <div className="hour-timeline">
                {monthEvents.some((e) => e.day === day && !e.time) && (
                  <div className="hour-row" key="unknown-time">
                    <time>{UNKNOWN_TIME}</time>
                    <div>
                      {monthEvents
                        .filter((e) => e.day === day && !e.time)
                        .map((e) => (
                          <button key={e.id} onClick={() => setSelected(e)} className="hour-event">
                            {flag(e.country)} {e.title}
                            <span>
                              {e.assets[0]} · {importancePresentation(e.importance).label}
                            </span>
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                {Array.from({ length: 24 }, (_, hour) => (
                  <div className="hour-row" key={hour}>
                    <time>{String(hour).padStart(2, '0')}:00</time>
                    <div>
                      {monthEvents
                        .filter(
                          (e) => e.day === day && !!e.time && Number(e.time.slice(0, 2)) === hour,
                        )
                        .map((e) => (
                          <button key={e.id} onClick={() => setSelected(e)} className="hour-event">
                            {flag(e.country)} {e.time} · {e.title}
                            <span>
                              {e.assets[0]} · {importancePresentation(e.importance).label}
                            </span>
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              agendaEvents.sort(compareEventTime).map((e) => (
                <button className="agenda-event" key={e.id} onClick={() => setSelected(e)}>
                  <span>
                    {`${Number(e.date.slice(5, 7))}.${e.day}`}
                    <small>{timeText(e.time)}</small>
                  </span>
                  <span>
                    {flag(e.country)} {e.title}
                    <small>
                      {e.category} · {e.assets[0]}
                    </small>
                  </span>
                  <span
                    className={`badge ${e.importance === 3 ? 'red' : 'amber'}`}
                    style={
                      e.importance === 1 ? { background: '#edf3fb', color: '#637fa5' } : undefined
                    }
                  >
                    {importancePresentation(e.importance).label}
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))
            )}
            {view !== '시간별' && !agendaEvents.length && (
              <div className="empty-state">
                <CalendarDays size={28} />
                <strong>표시할 일정이 없습니다</strong>
                <p>기간을 이동하거나 필터를 변경해 보세요.</p>
              </div>
            )}
          </div>
        )}
        <div className="calendar-legend">
          <span>
            <i className="importance-dot high" /> 높음
          </span>
          <span>
            <i className="importance-dot medium" /> 보통
          </span>
          <span>
            <i className="importance-dot low" /> 낮음
          </span>
          <span className="legend-note">
            일정을 클릭하면 영향 분석을 확인할 수 있어요 <ArrowRight size={12} />
          </span>
        </div>
      </section>
      <div className="bottom-grid">
        <section className="detail-card">
          <div className="card-heading">
            <div>
              <span className="section-kicker">COMING UP</span>
              <h3>주목할 경제 일정</h3>
            </div>
            <span className="subtle">등록 일정 · 출처 확인</span>
          </div>
          {selectedEvent ? (
            <>
              <div className="detail-title">
                <span className="country-circle">{flag(selectedEvent.country)}</span>
                <div>
                  <h3>
                    {selectedEvent.releaseType && (
                      <span className="release-type">{selectedEvent.releaseType}</span>
                    )}
                    {selectedEvent.title}
                  </h3>
                  <p>
                    {selectedEvent.date.replaceAll('-', '. ')}.{' · '}
                    {selectedEvent.time ? `${selectedEvent.time} KST` : UNKNOWN_TIME}
                  </p>
                  {selectedEvent.titleOriginal && (
                    <div className="original-title">
                      <button
                        type="button"
                        aria-expanded={shownOriginals.includes(selectedEvent.id)}
                        onClick={() =>
                          setShownOriginals((v) =>
                            v.includes(selectedEvent.id)
                              ? v.filter((i) => i !== selectedEvent.id)
                              : [...v, selectedEvent.id],
                          )
                        }
                      >
                        {shownOriginals.includes(selectedEvent.id)
                          ? '원문 제목 숨기기'
                          : '원문 제목 보기'}
                      </button>
                      <small>
                        {selectedEvent.translation
                          ? `AI 번역 · ${selectedEvent.translation.model}`
                          : '공식 원문 제목(정리 전)'}
                      </small>
                      {shownOriginals.includes(selectedEvent.id) && (
                        <q lang={selectedEvent.translation ? 'en' : 'ko'}>
                          {selectedEvent.titleOriginal}
                        </q>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className={`icon-button star-button ${saved.includes(selectedEvent.id) ? 'is-saved' : ''}`}
                  aria-label={
                    saved.includes(selectedEvent.id) ? '관심 일정 해제' : '관심 일정 저장'
                  }
                  onClick={() =>
                    setSaved((v) =>
                      v.includes(selectedEvent.id)
                        ? v.filter((i) => i !== selectedEvent.id)
                        : [...v, selectedEvent.id],
                    )
                  }
                >
                  <Star
                    size={18}
                    fill={saved.includes(selectedEvent.id) ? 'currentColor' : 'none'}
                  />
                </button>
              </div>
              <div className="detail-values">
                <div>
                  <small>예상치</small>
                  <strong>{selectedEvent.forecast}</strong>
                </div>
                <div>
                  <small>이전 수치</small>
                  <strong>{selectedEvent.previous}</strong>
                </div>
                <div>
                  <small>중요도</small>
                  <strong
                    className={selectedEvent.importance === 3 ? 'text-red' : 'text-amber'}
                    style={selectedEvent.importance === 1 ? { color: '#637fa5' } : undefined}
                  >
                    {importancePresentation(selectedEvent.importance).dots}{' '}
                    <em>{importancePresentation(selectedEvent.importance).label}</em>
                  </strong>
                </div>
              </div>
              {selectedEvent.values && selectedEvent.values.length > 0 && (
                <ul className="event-values" aria-label="발표 결과">
                  {selectedEvent.values.map((value) => (
                    <li key={value.indicatorId}>
                      <strong>{value.label}</strong>
                      <span>
                        발표 <b>{value.actual}</b>
                        {value.unit ? ` ${value.unit}` : ''} · 이전 <b>{value.previous ?? '—'}</b>
                      </span>
                      <small>
                        기준 {value.period.slice(0, 7).replace('-', '. ')} · 출처 {value.source} ·{' '}
                        {formatKst(value.observedAt)} KST 확인
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              <EventEnrichmentDetail event={selectedEvent} />
              {selectedEvent.aiSummary?.text && (
                <div className="ai-summary" aria-label="AI 요약">
                  <strong>
                    <Sparkles size={13} /> AI 요약
                  </strong>
                  <p>{selectedEvent.aiSummary.text}</p>
                  <small>
                    {selectedEvent.aiSummary.model} ·{' '}
                    {formatKst(selectedEvent.aiSummary.generatedAt)} KST · AI가 만든 요약이라 틀릴
                    수 있습니다. 발표 값은 위 출처에서 확인하세요.
                  </small>
                </div>
              )}
              <div className="tag-row">
                <span>{selectedEvent.category}</span>
                {selectedEvent.assets.map((a) => (
                  <span key={a}>{a}</span>
                ))}
                <span>{selectedEvent.country} 시장</span>
                {saved.includes(selectedEvent.id) && (
                  <span className="saved-tag">
                    <Check size={12} /> 관심 일정
                  </span>
                )}
              </div>
              {selectedEvent.sourceUrl && (
                <div className="event-provenance">
                  <SourceLink url={selectedEvent.sourceUrl}>
                    {selectedEvent.sourceName}
                    <ExternalLink size={11} />
                  </SourceLink>
                  <span>
                    확인:{' '}
                    {selectedEvent.factualObservedAt
                      ? formatKst(selectedEvent.factualObservedAt)
                      : '—'}{' '}
                    KST
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">이 기간의 등록 일정이 없습니다.</div>
          )}
        </section>
        <section className="impact-card">
          <div className="card-heading">
            <div className="impact-heading">
              <span className="sparkle-icon">
                <Sparkles size={17} />
              </span>
              <h3>시장 영향 살펴보기</h3>
            </div>
            <span className="ai-label">시나리오</span>
          </div>
          <p>
            {selectedEvent?.description ??
              '일정을 선택하면 자산에 미칠 수 있는 영향을 확인할 수 있습니다.'}
          </p>
          <div className="impact-assets">
            <span>영향 자산</span>
            <strong>{selectedEvent?.assets.join(' · ') ?? '—'}</strong>
            <span className="impact-divider" />
            <span>분석 시계</span>
            <strong>{selectedEvent?.impactHorizon ?? '발표 후 1–5일'}</strong>
          </div>
          <div className="impact-disclaimer">
            <CircleHelp size={13} />
            <span>
              {`출처: ${selectedEvent?.sourceName ?? '등록 일정 없음'} · 확신 ${selectedEvent?.confidence === 'high' ? '높음' : selectedEvent?.confidence === 'medium' ? '보통' : '낮음'} · 방향 ${selectedEvent?.impactDirection === 'up' ? '상승' : selectedEvent?.impactDirection === 'down' ? '하락' : selectedEvent?.impactDirection === 'mixed' ? '혼합' : '미정'}`}{' '}
              · 다른 조건이 동일하다는 가정이며 실제 결과와 다를 수 있습니다.
            </span>
          </div>
        </section>
      </div>
      {importOpen && (
        <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
          <section
            className="modal calendar-import-modal"
            role="dialog"
            aria-modal="true"
            aria-label="일정 JSON 등록"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" aria-label="닫기" onClick={() => setImportOpen(false)}>
              <X size={18} />
            </button>
            <h2>출처가 있는 일정 등록</h2>
            <p>
              JSON의 events 배열(1–100개)을 검증 후 ID 기준으로 추가·갱신합니다. 실제 출처 URL과
              확인 시각을 포함하세요. 임의 전망을 사실처럼 입력하지 마세요.
            </p>
            <details>
              <summary>필수 JSON 필드 보기</summary>
              <pre>{`{ events: [{ id: 정수, date: YYYY-MM-DD, time: HH:mm, title: 문자열, country: 한국|미국|글로벌, category: 문자열, assets: 문자열[], importance: 1|2|3, description: 문자열, sourceUrl: HTTPS URL, sourceName: 문자열, impactDirection: mixed|up|down|unknown, impactHorizon: 문자열, confidence: low|medium|high, factualObservedAt: ISO 시각, forecast?: 문자열, previous?: 문자열 }] }`}</pre>
            </details>
            <form onSubmit={importEvents}>
              <label>
                일정 JSON
                <textarea
                  aria-label="일정 JSON"
                  rows={12}
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  required
                  spellCheck={false}
                />
              </label>
              {importError && (
                <div role="alert" className="form-error">
                  {importError}
                </div>
              )}
              <button className="button primary" disabled={importLoading} type="submit">
                {importLoading ? '검증 및 등록 중…' : '검증 후 등록'}
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
