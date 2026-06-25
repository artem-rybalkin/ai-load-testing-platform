import { useEffect, useRef, useState } from 'react';
import { getActiveTests, ActiveTest } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';
import { Link } from 'react-router-dom';

export default function ActiveTests() {
  const [active, setActive] = useState<ActiveTest[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    try {
      const data = await getActiveTests();
      setActive(data.active || []);
    } catch {}
  };

  // Initial load
  useEffect(() => { refresh(); }, []);

  // Real-time updates via WebSocket — replaces 3s polling.
  // Debounced 50ms: consumer broadcasts both test:status + tests:changed together;
  // the debounce coalesces them into a single fetch.
  useResultsSocket((event) => {
    if (event.type === 'tests:changed' || event.type === 'test:status' || event.type === 'reconnected') {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refresh, 50);
    }
  });

  if (active.length === 0) return null;

  return (
    <div className="bg-orange-bg border-b border-orange-bd px-4 md:px-9 py-2 flex items-center gap-3 flex-wrap">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent font-mono">
        <span className="w-1.5 h-1.5 bg-accent rounded-full pulse-dot inline-block" />
        {active.length} test{active.length > 1 ? 's' : ''} running
      </span>
      <div className="flex gap-2 flex-wrap">
        {active.map(t => (
          <Link
            key={t.test_id}
            to={`/results/${t.test_id}`}
            className="text-[11px] font-mono text-accent hover:underline flex items-center gap-1"
          >
            <span>{t.type === 'client-side' ? '🌐' : t.type === 'flow' ? '🔗' : '⚡'}</span>
            <span className="max-w-[160px] truncate">{t.target_url.replace(/https?:\/\//, '')}</span>
            <span className="text-tx-4">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
