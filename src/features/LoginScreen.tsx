import { useState } from 'react';
import { Activity, ArrowRight, ShieldCheck } from 'lucide-react';

export type SessionUser = { id?: string; email: string; role: string };

/** The only screen shown to signed-out visitors. There is no preview or browsing mode. */
export default function LoginScreen({ onLoggedIn }: { onLoggedIn: (user: SessionUser) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? '로그인 시도 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
            : '이메일 또는 비밀번호를 확인해 주세요. 활성화된 관리자 등록 계정만 로그인할 수 있습니다.',
        );
      onLoggedIn((await response.json()).user);
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand login-brand">
          <span className="brand-symbol">
            <Activity size={23} />
          </span>
          folio<span className="brand-dot">.</span>
        </div>
        <div className="modal-symbol">
          <ShieldCheck size={24} />
        </div>
        <h1 id="login-title">나의 투자 공간에 로그인</h1>
        <p>
          관리자가 등록한 계정으로 접속하세요. 로그인 전에는 어떤 시세나 자산도 표시하지 않습니다.
        </p>
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
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? '확인 중…' : '로그인'}
            <ArrowRight size={16} />
          </button>
        </form>
      </section>
    </main>
  );
}
