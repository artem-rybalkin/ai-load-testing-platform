'use client';

import { useEffect, useState } from 'react';
import { getActiveTests, ActiveTest } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';
import Link from 'next/link';

export default function ActiveTests() {
  const [active, setActive] = useState<ActiveTest[]>([]);

  const refresh = async () => {
    try {
      const data = await getActiveTests();
      setActive(data.active || []);
    } catch {}
  };

  // Initial load
  useEffect(() => { refresh(); }, []);

  // Real-time updates via WebSocket — replaces 3s polling
  useResultsSocket((event) => {
    if (event.type === 'tests:changed' || event.type === 'test:status') {
      refresh();
    }
  });

  if (active.length === 0) return null;

  return (
    <div className="bg-[#ddf4ff] border-b border-[#54aeff40] px-4 py-1.5 flex items-center gap-3 flex-wrap">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-[#0969da] font-mono">
        <span className="w-1.5 h-1.5 bg-[#0969da] rounded-full animate-pulse inline-block" />
        {active.length} test{active.length > 1 ? 's' : ''} running
      </span>
      <div className="flex gap-2 flex-wrap">
        {active.map(t => (
          <Link
            key={t.test_id}
            href={`/results/${t.test_id}`}
            className="text-[11px] font-mono text-[#0969da] hover:underline flex items-center gap-1"
          >
            <span>{t.type === 'client-side' ? '🌐' : t.type === 'flow' ? '🔗' : '⚡'}</span>
            <span className="max-w-[160px] truncate">{t.target_url.replace(/https?:\/\//, '')}</span>
            <span className="text-[#57606a]">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
