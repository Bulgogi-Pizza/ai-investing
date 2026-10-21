import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bell,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Wallet,
  X,
} from 'lucide-react';
import Portfolio from './features/portfolio';
import Recommendations from './features/recommendations';
import CalendarPage from './features/calendar/CalendarPage';
import AnalysisPage from './features/analysis/AnalysisPage';
import LoginScreen, { type SessionUser } from './features/LoginScreen';
import MarketStrip from './features/MarketStrip';
import BudgetBanner from './features/BudgetBanner';
import { DataState, LoadingState } from './components/DataState';
import { ApiError, AUTH_REQUIRED_EVENT, useApiResource } from './lib/api';

type Page = 'calendar' | 'analysis' | 'portfolio' | 'ai';
const nav = [
  { id: 'calendar', label: '경제 캘린더', icon: CalendarDays },
  { id: 'analysis', label: '종목 분석', icon: ChartNoAxesCombined },
  { id: 'portfolio', label: '내 자산', icon: Wallet },
  { id: 'ai', label: 'AI 인사이트', icon: Sparkles },
] as const;
const watchlist = [
  { label: '삼성전자', symbol: '005930', icon: '삼', tone: 'samsung' },
  { label: 'Apple', symbol: 'AAPL', icon: 'A', tone: 'apple' },
] as const;
type Session =
  | { status: 'checking' }
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'authenticated'; user: SessionUser };

type WatchPrices = { prices: { symbol: string; lastPrice: string; currency: 'KRW' | 'USD' }[] };
function parseWatchPrices(body: unknown): WatchPrices {
  const v = body as WatchPrices;
  if (
    !Array.isArray(v?.prices) ||
    !v.prices.every(
      (p) =>
        typeof p?.symbol === 'string' &&
        Number.isFinite(Number(p.lastPrice)) &&
        (p.currency === 'KRW' || p.currency === 'USD'),
    )
  )
    throw new ApiError(502, 'INVALID_RESPONSE', '시세 응답 형식을 확인하지 못했습니다.');
  return v;
}
const priceLabel = (price: WatchPrices['prices'][number]) =>
  price.currency === 'KRW'
    ? `${Number(price.lastPrice).toLocaleString('ko-KR')}원`
    : `$${Number(price.lastPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function App() {
  const [session, setSession] = useState<Session>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSession({ status: 'checking' });
    fetch('/api/auth/me', { signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) return setSession({ status: 'anonymous' });
        if (!response.ok) throw new Error('session check failed');
        const body = await response.json();
        if (!body?.user?.email) throw new Error('invalid session');
        setSession({ status: 'authenticated', user: body.user });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSession({ status: 'unavailable' });
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    // A 401 on any private request means the session ended: show the login screen again.
    const expired = () =>
      setSession((current) =>
        current.status === 'authenticated' ? { status: 'anonymous' } : current,
      );
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
  }, []);
  if (session.status === 'checking')
    return (
      <main className="login-screen">
        <LoadingState label="로그인 상태를 확인하는 중…" />
      </main>
    );
  if (session.status === 'unavailable')
    return (
      <main className="login-screen">
        <DataState
          issue={{
            kind: 'error',
            message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
            retryable: true,
          }}
          onRetry={() => setAttempt((v) => v + 1)}
        />
      </main>
    );
  if (session.status === 'anonymous')
    return <LoginScreen onLoggedIn={(user) => setSession({ status: 'authenticated', user })} />;
  return <Workspace user={session.user} onLoggedOut={() => setSession({ status: 'anonymous' })} />;
}

function Workspace({ user, onLoggedOut }: { user: SessionUser; onLoggedOut: () => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  // Telegram alerts link to /algorithms: open 내 자산 > 알고리즘 for that path.
  const [page, setPage] = useState<Page>(() =>
    window.location.pathname === '/algorithms' ? 'portfolio' : 'calendar',
  );
  const [initialSymbol, setInitialSymbol] = useState('005930');
  const [sessionError, setSessionError] = useState('');
  const [accounts, setAccounts] = useState<
    { id: string; email: string; role: string; active: boolean }[]
  >([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [authError, setAuthError] = useState('');
  const [notice, setNotice] = useState(false);
  const [search, setSearch] = useState('');
  const watch = useApiResource(
    `/api/market/prices?symbols=${watchlist.map((w) => w.symbol).join(',')}`,
    parseWatchPrices,
  );
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  async function createAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError('');
    const form = new FormData(e.currentTarget);
    try {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (!r.ok) throw new Error('계정 생성에 실패했습니다. 관리자 권한과 입력값을 확인해 주세요.');
      await loadAccounts();
      setAuthError('계정을 등록했습니다.');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '연결에 실패했습니다.');
    }
  }
  async function loadAccounts() {
    setAdminLoading(true);
    try {
      const r = await fetch('/api/admin/users');
      if (!r.ok) throw new Error('계정 목록을 불러오지 못했습니다.');
      const d = await r.json();
      setAccounts(d.users);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : '계정 조회 실패');
    } finally {
      setAdminLoading(false);
    }
  }
  async function logout() {
    setSessionError('');
    try {
      const r = await fetch('/api/auth/logout', { method: 'POST' });
      if (!r.ok && r.status !== 401)
        throw new Error('로그아웃에 실패했습니다. 다시 시도해 주세요.');
      onLoggedOut();
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : '연결 오류');
    }
  }
  async function revoke(id: string) {
    setAuthError('');
    try {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error('비활성화하지 못했습니다.');
      await loadAccounts();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : '요청 실패');
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('calendar');
          }}
        >
          <span className="brand-symbol">
            <Activity size={23} />
          </span>
          folio<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">MY INVESTING SPACE</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? 'active' : ''}`}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={19} />
              {n.label}
              {n.id === 'ai' && <span className="new-label">NEW</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-caption">
          나의 워치리스트 <Star size={13} />
        </div>
        {watchlist.map((item) => {
          const price =
            watch.state.status === 'ready'
              ? watch.state.data.prices.find((p) => p.symbol === item.symbol)
              : undefined;
          return (
            <button
              key={item.symbol}
              className="watch-item"
              onClick={() => {
                setInitialSymbol(item.symbol);
                setPage('analysis');
              }}
            >
              <span className={`stock-icon ${item.tone}`}>{item.icon}</span>
              <span>
                {item.label}
                <small>{item.symbol}</small>
              </span>
              <span
                className="watch-price"
                title={
                  watch.state.status === 'issue'
                    ? watch.state.issue.message
                    : price
                      ? '토스증권 현재가'
                      : undefined
                }
              >
                {price ? priceLabel(price) : watch.state.status === 'loading' ? '…' : '—'}
              </span>
            </button>
          );
        })}
        <button className="watch-add" onClick={() => setPage('analysis')}>
          <Plus size={15} /> 관심종목 관리
        </button>
        <div className="sidebar-bottom">
          <div className="private-card">
            <ShieldCheck size={21} />
            <strong>나만의 투자 공간</strong>
            <p>
              차분하게 기록하고,
              <br />더 나은 결정을 만들어 보세요.
            </p>
            <span>개인 전용 · 주문 기능 없음</span>
          </div>
          <button className="help-button" onClick={() => setNotice(!notice)}>
            <CircleHelp size={17} /> 데이터 안내 <ExternalLink size={13} />
          </button>
          <div className="profile">
            <span className="avatar">U</span>
            <div>
              <strong>내 투자 계정</strong>
              <small>{user.role === 'admin' ? '관리자 · 로그인됨' : '로그인됨'}</small>
            </div>
            <button aria-label="로그아웃" onClick={() => void logout()}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            내 워크스페이스 <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="top-actions">
            <label className="search-box">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="경제 일정 검색"
                placeholder="경제 일정 검색"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage('calendar');
                }}
              />
              <span>⌘ K</span>
            </label>
            <button className="icon-button" aria-label="알림" onClick={() => setNotice(!notice)}>
              <Bell size={19} />
              <i />
            </button>
            {user.role === 'admin' && (
              <button
                className="button small"
                onClick={() => {
                  setAdmin(true);
                  setAuthError('');
                  void loadAccounts();
                }}
              >
                계정 등록
              </button>
            )}
            <button className="button small header-login" onClick={() => void logout()}>
              로그아웃
            </button>
          </div>
        </header>
        <main>
          <BudgetBanner />
          <MarketStrip />
          {sessionError && (
            <div role="alert" className="form-error">
              {sessionError}
            </div>
          )}
          {notice && (
            <div className="data-notice">
              <ShieldCheck size={17} />
              <span>
                시세·자산은 소유자 계정에 연결된 토스증권 조회 결과이고, 일정은 관리자가 출처와 함께
                등록한 자료입니다. 데이터를 받지 못하면 예시 값으로 대체하지 않고 원인을 안내합니다.
                모든 시간은 KST입니다.
              </span>
              <button aria-label="안내 닫기" onClick={() => setNotice(false)}>
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'calendar' ? (
            <CalendarPage search={search} isAdmin={user.role === 'admin'} />
          ) : page === 'analysis' ? (
            <AnalysisPage key={initialSymbol} initialSymbol={initialSymbol} />
          ) : page === 'portfolio' ? (
            <Portfolio />
          ) : (
            <Recommendations />
          )}
          <footer>
            folio — 더 넓게 보고, 나답게 투자하기.
            <span>실제 조회 데이터만 표시 · KST (UTC+9)</span>
          </footer>
        </main>
      </div>
      {admin && (
        <div className="modal-backdrop" onClick={() => setAdmin(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="계정 등록"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" aria-label="닫기" onClick={() => setAdmin(false)}>
              <X size={19} />
            </button>
            <div className="modal-symbol">
              <ShieldCheck size={24} />
            </div>
            <h2>계정 관리</h2>
            <p>관리자가 등록한 활성 계정만 접근할 수 있습니다.</p>
            <section className="admin-account-list" aria-label="등록된 계정">
              <h3>등록된 계정</h3>
              {adminLoading ? (
                <p role="status">불러오는 중…</p>
              ) : accounts.length ? (
                accounts.map((account) => (
                  <div className="admin-account-row" key={account.id}>
                    <div>
                      <strong>{account.email}</strong>
                      <small>
                        {account.role === 'admin' ? '관리자' : '일반 계정'} ·{' '}
                        {account.active ? '활성' : '비활성'}
                      </small>
                    </div>
                    {account.role !== 'admin' && account.active && (
                      <button className="button small" onClick={() => void revoke(account.id)}>
                        접근 해제
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p>표시할 계정이 없습니다.</p>
              )}
            </section>
            <form onSubmit={createAccount}>
              <label>
                이메일
                <input name="email" type="email" autoComplete="off" required />
              </label>
              <label>
                비밀번호
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </label>
              {authError && (
                <div role="alert" className="form-error">
                  {authError}
                </div>
              )}
              <button className="button primary" type="submit">
                계정 등록
                <ArrowRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
