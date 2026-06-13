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

  return (
    <div className="min-h-screen bg-[#f6f7f8] flex items-center justify-center p-4">
      <div className="bg-white border border-[#d0d7de] rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-[#1f2328] mb-1">{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
        <p className="text-sm text-[#57606a] mb-6">
          {mode === 'login' ? 'Enter your email and password to continue' : 'Set up your account and team'}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-[#1f2328] mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1f2328] mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
            />
          </div>

          {mode === 'register' && (
            <>
              <div>
                <label className="block text-sm font-medium text-[#1f2328] mb-1">Name (optional)</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="your name"
                  className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#1f2328] mb-1">Team name</label>
                <input
                  type="text"
                  value={teamName}
                  onChange={e => setTeamName(e.target.value)}
                  placeholder="my-team"
                  required
                  className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
                />
                <p className="text-xs text-[#57606a] mt-1">
                  Creates a new team — you'll be its admin
                </p>
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-[#cf222e]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="bg-[#1f883d] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#1a7a35] disabled:opacity-50 cursor-pointer"
          >
            {loading ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : (mode === 'login' ? 'Sign in' : 'Create account')}
          </button>

          <button
            type="button"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
            className="text-sm text-[#0969da] hover:underline cursor-pointer"
          >
            {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
