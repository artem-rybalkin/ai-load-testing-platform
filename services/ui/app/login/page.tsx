import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register } from '@/lib/api';
import { useAuth } from '@/lib/AuthContext';

export default function LoginPage() {
  const [mode, setMode]       = useState<'login' | 'register'>('login');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [name, setName]       = useState('');
  const [teamName, setTeamName] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const navigate  = useNavigate();
  const { setUser } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = mode === 'login'
        ? await login(email.trim(), password)
        : await register(email.trim(), password, teamName.trim(), name.trim() || undefined);
      setUser(user);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : `${mode === 'login' ? 'Login' : 'Registration'} failed — please try again`);
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full bg-bg border border-border rounded-control px-3.5 py-2.5 text-[13.5px] text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5";
  const labelCls = "font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5 block";

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <span className="font-display text-[22px] font-bold tracking-[-0.01em] whitespace-nowrap">ARTEM RYBALKIN<span className="text-accent">.</span></span>
          <div className="font-mono text-[10.5px] tracking-[0.16em] text-tx-4 uppercase mt-1">load testing</div>
        </div>
        <div className="bg-surface border border-border rounded-card p-8">
          <h1 className="font-display text-[22px] font-bold tracking-[-0.02em] mb-1">{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
          <p className="text-[13px] text-tx-3 mb-6">
            {mode === 'login' ? 'Enter your email and password to continue' : 'Set up your account and team'}
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div>
              <label className={labelCls}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                className={inputCls}
              />
            </div>

            {mode === 'register' && (
              <>
                <div>
                  <label className={labelCls}>Name (optional)</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="your name"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Team name</label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    placeholder="my-team"
                    required
                    className={inputCls}
                  />
                  <p className="text-[11.5px] text-tx-4 mt-1.5">
                    Creates a new team — you&apos;ll be its admin
                  </p>
                </div>
              </>
            )}

            {error && (
              <p className="text-[13px] text-red-fg">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2.75 text-[13.5px] font-bold disabled:opacity-50 cursor-pointer transition-colors"
            >
              {loading ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : (mode === 'login' ? 'Sign in' : 'Create account')}
            </button>

            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              className="text-[13px] text-accent hover:underline cursor-pointer"
            >
              {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
