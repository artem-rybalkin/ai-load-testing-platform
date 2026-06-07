'use client';

import { useEffect, useState } from 'react';
import { ServiceHealth } from '@/lib/api';
import { useHealth } from '@/lib/HealthContext';

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
  const { services } = useHealth();
  const issues = services.filter(s => s.status !== 'ok');
  const [dismissedKey, setDismissedKey] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  });

  // Auto-clear dismissal when the set of unhealthy services changes
  useEffect(() => {
    if (issues.length > 0) {
      const current = issueKey(issues);
      const stored = (() => { try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; } })();
      if (current !== stored) setDismissedKey('');
    }
  }, [issues.map(s => s.name).sort().join(',')]);

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
