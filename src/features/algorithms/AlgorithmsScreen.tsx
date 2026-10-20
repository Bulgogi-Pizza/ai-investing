import { useCallback, useState } from 'react';
import { Info, Plus } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import { templateDefaults } from '../../lib/algo';
import { maxAlgorithms, type AlgorithmRecord } from '../../lib/algorithmRecords';
import { useApiResource } from '../../lib/api';
import { AlgorithmForm } from './AlgorithmForm';
import { BacktestPanel } from './BacktestPanel';
import { CostSettings } from './CostSettings';
import { EmergencyStop } from './EmergencyStop';
import { HistoryList, NotificationsList } from './HistoryAndNotifications';
import { LivePanel } from './LivePanel';
import { PaperPanel } from './PaperPanel';
import { SafeguardSettings } from './SafeguardSettings';
import { invalidResponse, isRecord, modeLabels, money } from './shared';
import './algorithms.css';

type ListData = { algorithms: AlgorithmRecord[] };
function parseList(body: unknown): ListData {
  const list = isRecord(body) ? body.algorithms : null;
  if (
    !Array.isArray(list) ||
    !list.every((a) => isRecord(a) && typeof a.id === 'string' && typeof a.name === 'string')
  )
    throw invalidResponse('알고리즘 목록');
  return { algorithms: list as AlgorithmRecord[] };
}

export function ModeBadge({ mode }: { mode: AlgorithmRecord['mode'] }) {
  return (
    <span className={`algo-badge algo-badge-${mode}`} data-mode={mode}>
      {modeLabels[mode]}
    </span>
  );
}

/**
 * 내 자산 > 알고리즘. Orders are placed only by the live job, never by this screen; the live-enable
 * panel switches an algorithm to live mode (explicit confirmation, Telegram alert).
 */
export default function AlgorithmsScreen() {
  const { state, retry } = useApiResource('/api/algorithms', parseList);
  // History and notifications reload after anything that can add a record to them.
  const [refresh, setRefresh] = useState(0);
  const bumpRefresh = useCallback(() => setRefresh((v) => v + 1), []);
  return (
    <div className="algo-screen">
      <EmergencyStop onChanged={bumpRefresh} />
      {(state.status === 'loading' || state.status === 'idle') && (
        <LoadingState label="알고리즘 목록을 불러오는 중…" />
      )}
      {state.status === 'issue' && (
        <DataState issue={state.issue} onRetry={retry} title="알고리즘을 불러오지 못했습니다" />
      )}
      {state.status === 'ready' && (
        <Loaded initial={state.data.algorithms} refresh={refresh} bumpRefresh={bumpRefresh} />
      )}
    </div>
  );
}

function Loaded({
  initial,
  refresh,
  bumpRefresh,
}: {
  initial: AlgorithmRecord[];
  refresh: number;
  bumpRefresh: () => void;
}) {
  const [algorithms, setAlgorithms] = useState(initial);
  const [selected, setSelected] = useState<string | 'new' | null>(initial[0]?.id ?? 'new');
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState('');
  const select = (id: string) => {
    setFlash('');
    setSelected(id);
  };
  const record = algorithms.find((a) => a.id === selected) ?? null;

  return (
    <>
      <p className="invest-connection algo-banner">
        <Info size={17} aria-hidden="true" />
        <span>
          이 화면은 알고리즘의 설정, <strong>시뮬레이션</strong>, <strong>모의(가상) 운용</strong>과
          사용자가 직접 켠 <strong>실전 자동 주문</strong>을 다룹니다. 주문은 이 화면이 아니라 운영
          작업이 내며, 실전은 알고리즘마다 &quot;실전 켜기&quot;에서 켠 것만, 모든 안전장치를 통과한
          주문만 나갑니다.
        </span>
      </p>
      <div className="algo-layout">
        <section className="invest-card algo-list" aria-labelledby="algo-list-title">
          <div className="invest-section-title">
            <div>
              <h2 id="algo-list-title">내 알고리즘</h2>
              <p>
                {algorithms.length}/{maxAlgorithms}개
              </p>
            </div>
            <button
              className="button"
              onClick={() => select('new')}
              disabled={algorithms.length >= maxAlgorithms}
            >
              <Plus size={14} aria-hidden="true" /> 새 알고리즘
            </button>
          </div>
          {algorithms.length === 0 ? (
            <DataState
              issue={{
                kind: 'no-data',
                message: '아직 만든 알고리즘이 없습니다. 오른쪽에서 템플릿을 골라 시작하세요.',
                retryable: false,
              }}
              title="알고리즘이 없습니다"
              compact
            />
          ) : (
            <ul>
              {algorithms.map((a) => (
                <li key={a.id}>
                  <button
                    className={`algo-card ${selected === a.id ? 'selected' : ''}`}
                    aria-pressed={selected === a.id}
                    onClick={() => select(a.id)}
                  >
                    <span className="algo-card-head">
                      <strong>{a.name}</strong>
                      <ModeBadge mode={a.mode} />
                    </span>
                    <small>
                      {a.method === 'ai' ? 'AI형' : templateDefaults[a.template].label} ·{' '}
                      {a.market === 'KR' ? '국내 KRW' : '미국 USD'} · 종목 {a.targets.length}개
                    </small>
                    <small>
                      운용 금액 {a.budget === null ? '미설정' : money(a.budget, a.currency)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="invest-card algo-editor" aria-labelledby="algo-editor-title">
          <div className="invest-section-title">
            <div>
              <h2 id="algo-editor-title">{record ? '알고리즘 설정' : '새 알고리즘'}</h2>
              <p>
                {record
                  ? `${record.name} · 버전 ${record.version}`
                  : '템플릿을 고르고 신호와 대상 종목을 정합니다.'}
              </p>
            </div>
            {record && <ModeBadge mode={record.mode} />}
          </div>
          <AlgorithmForm
            key={`${record?.id ?? 'new'}:${record?.mode ?? ''}`}
            record={record}
            onDirtyChange={setDirty}
            initialNotice={flash}
            onSaved={(saved, message) => {
              setFlash(message);
              setAlgorithms((list) =>
                list.some((a) => a.id === saved.id)
                  ? list.map((a) => (a.id === saved.id ? saved : a))
                  : [...list, saved],
              );
              setSelected(saved.id);
              bumpRefresh();
            }}
            onDeleted={(id) => {
              setFlash('');
              const rest = algorithms.filter((a) => a.id !== id);
              setAlgorithms(rest);
              setSelected(rest[0]?.id ?? 'new');
              bumpRefresh();
            }}
          />
        </section>
      </div>
      {record ? (
        <>
          <BacktestPanel key={record.id} record={record} dirty={dirty} />
          <PaperPanel key={`paper-${record.id}`} record={record} refreshKey={refresh} />
          <LivePanel
            key={`live-${record.id}`}
            record={record}
            dirty={dirty}
            refreshKey={refresh}
            onChanged={(saved, message) => {
              setFlash(message);
              setAlgorithms((list) => list.map((a) => (a.id === saved.id ? saved : a)));
              bumpRefresh();
            }}
          />
        </>
      ) : (
        <section className="invest-card">
          <p className="invest-muted">알고리즘을 저장하면 과거 시뮬레이션을 실행할 수 있습니다.</p>
        </section>
      )}
      <HistoryList algorithms={algorithms} refreshKey={refresh} />
      <CostSettings />
      <SafeguardSettings onChanged={bumpRefresh} />
      <NotificationsList refreshKey={refresh} />
    </>
  );
}
