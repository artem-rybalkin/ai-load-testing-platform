'use client';

import { useEffect, useState } from 'react';
import { getSystemHealth, ServiceHealth } from '@/lib/api';

const SERVICE_LABELS: Record<string, string> = {
  'results-service': 'Results DB',
  'api-service':     'API',
  'ai-service':      'AI (Gemini)',
  'worker-backend':  'k6 Worker',
  'worker-client':   'Browser Worker',
};

const SERVICE_IMPACT: Record<string, (s: ServiceHealth) => string> = {
  'ai-service':     () => 'New tests cannot be started',
  'worker-backend': s => s.status === 'saturated' ? 'At capacity — new tests queuing' : 'Backend & flow tests will queue',
  'worker-client':  s => s.status === 'saturated' ? 'At capacity — new tests queuing' : 'Browser tests will queue',
  'api-service':    () => 'Test creation unavailable',
  'results-service':() => 'Results unavailable',
};

const STORAGE_KEY = 'systemHealthDismissed';

const issueKey = (services: ServiceHealth[]) =>
  services.map(s => s.name).sort().join(',');

export default function SystemHealth() {
  const [issues, setIssues] = useState<ServiceHealth[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    const check = async () => {
      try {
        const data = await getSystemHealth();
        const newIssues = data.services.filter(s => s.status !== 'ok');
        setIssues(newIssues);
        // Auto-clear dismissal when the set of unhealthy services changes
        if (newIssues.length > 0) {
          const current = issueKey(newIssues);
          setDismissedKey(prev => {
            const stored = (() => { try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; } })();
            return current === stored ? prev : '';
          });
        }
      } catch { /* network error — don't surface */ }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  const dismiss = () => {
    const key = issueKey(issues);
    try { localStorage.setItem(STORAGE_KEY, key); } catch { /* private browsing */ }
    setDismissedKey(key);
  };

  const isDismissed = issues.length === 0 || dismissedKey === issueKey(issues);
  if (isDismissed) return null;

  return (
    <div className="bg-[#fff8c5] border-b border-[#e3b341] px-4 py-2 flex items-start gap-3">
      <span className="text-[#9a6700] text-[13px] mt-0.5 shrink-0">⚠</span>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-semibold text-[#9a6700]">System issues detected</span>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          {issues.map(s => (
            <span key={s.name} className="text-[11px] font-mono text-[#9a6700]">
              <span className="font-semibold">{SERVICE_LABELS[s.name] ?? s.name}</span>
              {' '}
              <span className="text-[#bf8700]">{s.status}</span>
              {SERVICE_IMPACT[s.name] && (
                <span className="text-[#9a6700] font-normal"> — {SERVICE_IMPACT[s.name](s)}</span>
              )}
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={dismiss}
        className="text-[#9a6700] hover:text-[#7a5100] text-[14px] shrink-0 leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
