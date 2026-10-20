import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LogIn,
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
import ChartsPage from './features/charts/ChartsPage';
type Page = 'calendar' | 'charts' | 'portfolio' | 'ai';
const nav = [
  { id: 'calendar', label: '경제 캘린더', icon: CalendarDays },
  { id: 'charts', label: '차트 분석', icon: ChartNoAxesCombined },
  { id: 'portfolio', label: '내 자산', icon: Wallet },
  { id: 'ai', label: 'AI 인사이트', icon: Sparkles },
] as const;
export default function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<Page>('calendar');
  const [initialSymbol, setInitialSymbol] = useState('삼성전자');
  const [authVersion, setAuthVersion] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [accounts, setAccounts] = useState<
    { id: string; email: string; role: string; active: boolean }[]
  >([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  const [login, setLogin] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [authError, setAuthError] = useState('');
  const [notice, setNotice] = useState(false);
  const [search, setSearch] = useState('');
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
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => {});
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError('');
    const form = new FormData(e.currentTarget);
    try {
      const r = await fetch(admin ? '/api/admin/users' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (!r.ok)
        throw new Error(
          admin
            ? '계정 생성에 실패했습니다. 관리자 권한과 입력값을 확인해 주세요.'
            : '이메일 또는 비밀번호를 확인해 주세요. 활성화된 관리자 등록 계정만 로그인할 수 있습니다.',
        );
      const d = await r.json();
      if (!admin) {
        setUser(d.user);
        setAuthVersion((v) => v + 1);
        setLogin(false);
      } else {
        await loadAccounts();
        setAuthError('계정을 등록했습니다.');
      }
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
      setUser(null);
      setAuthVersion((v) => v + 1);
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
        <button
          className="watch-item"
          onClick={() => {
            setInitialSymbol('삼성전자');
            setPage('charts');
          }}
        >
          <span className="stock-icon samsung">삼</span>
          <span>
            삼성전자<small>005930</small>
          </span>
          <span className="watch-change">+1.24%</span>
        </button>
        <button
          className="watch-item"
          onClick={() => {
            setInitialSymbol('Apple');
            setPage('charts');
          }}
        >
          <span className="stock-icon apple">A</span>
          <span>
            Apple<small>AAPL</small>
          </span>
          <span className="watch-change">+0.82%</span>
        </button>
        <button className="watch-add" onClick={() => setPage('charts')}>
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
            <span className="avatar">{user ? 'U' : 'D'}</span>
            <div>
              <strong>{user ? '내 투자 계정' : '데모 워크스페이스'}</strong>
              <small>{user ? '로그인됨' : '둘러보기 모드'}</small>
            </div>
            <button
              aria-label={user ? '로그아웃' : '로그인'}
              onClick={async () => {
                if (user) {
                  await logout();
                } else {
                  setAdmin(false);
                  setAuthError('');
                  setLogin(true);
                }
              }}
            >
              {user ? <LogOut size={17} /> : <LogIn size={17} />}
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
            {user?.role === 'admin' && (
              <button
                className="button small"
                onClick={() => {
                  setAdmin(true);
                  setAuthError('');
                  setLogin(true);
                  void loadAccounts();
                }}
              >
                계정 등록
              </button>
            )}
            <button
              className="button small header-login"
              onClick={() => {
                if (user) void logout();
                else {
                  setAdmin(false);
                  setAuthError('');
                  setLogin(true);
                }
              }}
            >
              {user ? '로그아웃' : '로그인'}
            </button>
            <span className="demo-pill">
              <span /> {user ? '샘플 시세 포함' : '합성 데모'}
            </span>
          </div>
        </header>
        <main>
          <div className="market-strip">
            {[
              { name: 'KOSPI', value: '2,641.25', change: '+0.74%', up: true },
              { name: 'S&P 500', value: '5,892.16', change: '+0.42%', up: true },
              { name: 'NASDAQ', value: '18,421.09', change: '+0.86%', up: true },
              { name: 'USD/KRW', value: '1,365.20', change: '−0.18%', up: false },
              { name: 'GOLD', value: '2,734.80', change: '+0.31%', up: true },
            ].map((m) => (
              <div className="market-item" key={m.name}>
                <span>{m.name}</span>
                <strong>{m.value}</strong>
                <small className={m.up ? 'positive' : 'negative'}>
                  {m.up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />} {m.change}
                </small>
              </div>
            ))}
            <span className="market-demo">
              예시 시세 <CircleHelp size={12} />
            </span>
          </div>
          {sessionError && (
            <div role="alert" className="form-error">
              {sessionError}
            </div>
          )}
          {notice && (
            <div className="data-notice">
              <ShieldCheck size={17} />
              <span>
                샘플 시세와 합성 데모는 실제 금융 정보가 아닙니다. 등록 일정과 토스 조회 모드는 각
                화면에 표시된 출처와 조회 시각을 확인하세요. 모든 시간은 KST입니다.
              </span>
              <button aria-label="안내 닫기" onClick={() => setNotice(false)}>
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'calendar' ? (
            <CalendarPage
              key={`calendar-${authVersion}`}
              search={search}
              isAdmin={user?.role === 'admin'}
            />
          ) : page === 'charts' ? (
            <ChartsPage key={initialSymbol} initialSymbol={initialSymbol} />
          ) : page === 'portfolio' ? (
            <Portfolio key={`portfolio-${authVersion}`} />
          ) : (
            <Recommendations key={`recommendations-${authVersion}`} />
          )}
          <footer>
            folio — 더 넓게 보고, 나답게 투자하기.
            <span>샘플 시세 포함 · 데모 기준일 2026.10.20 · KST (UTC+9)</span>
          </footer>
        </main>
      </div>
      {login && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setLogin(false);
            setAdmin(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={admin ? '계정 등록' : '로그인'}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="닫기"
              onClick={() => {
                setLogin(false);
                setAdmin(false);
              }}
            >
              <X size={19} />
            </button>
            <div className="modal-symbol">
              <ShieldCheck size={24} />
            </div>
            <h2>{admin ? '계정 관리' : '나의 투자 공간에 로그인'}</h2>
            <p>
              {admin
                ? '관리자가 등록한 활성 계정만 접근할 수 있습니다.'
                : '관리자가 등록한 계정으로 안전하게 접속하세요.'}
            </p>
            {admin && (
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
            )}
            <form onSubmit={submit}>
              <label>
                이메일
                <input name="email" type="email" autoComplete="username" required />
              </label>
              <label>
                비밀번호
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  autoComplete={admin ? 'new-password' : 'current-password'}
                  required
                />
              </label>
              {authError && (
                <div role="alert" className="form-error">
                  {authError}
                </div>
              )}
              <button className="button primary" type="submit">
                {admin ? '계정 등록' : '로그인'}
                <ArrowRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
