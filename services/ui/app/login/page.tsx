import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '@/lib/api';
import { useAuth } from '@/lib/AuthContext';

export default function LoginPage() {
  const [username, setUsername]     = useState('');
  const [projectName, setProject]   = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const navigate  = useNavigate();
  const { setUser } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(username.trim(), projectName.trim());
      setUser(user);
      navigate('/');
    } catch {
      setError('Login failed — please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f7f8] flex items-center justify-center p-4">
      <div className="bg-white border border-[#d0d7de] rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-[#1f2328] mb-1">Sign in</h1>
        <p className="text-sm text-[#57606a] mb-6">Enter your name and project to continue</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-[#1f2328] mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="your name"
              required
              className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1f2328] mb-1">Project</label>
            <input
              type="text"
              value={projectName}
              onChange={e => setProject(e.target.value)}
              placeholder="my-project"
              required
              className="w-full border border-[#d0d7de] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0969da] focus:border-[#0969da]"
            />
            <p className="text-xs text-[#57606a] mt-1">
              Share this name with teammates to access the same data
            </p>
          </div>

          {error && (
            <p className="text-sm text-[#cf222e]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="bg-[#1f883d] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#1a7a35] disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
