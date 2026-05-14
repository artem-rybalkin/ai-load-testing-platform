'use client';

import { useEffect, useState } from 'react';
import { getActiveTests, ActiveTest } from '@/lib/api';
import Link from 'next/link';

export default function ActiveTests() {
  const [active, setActive] = useState<ActiveTest[]>([]);

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await getActiveTests();
        setActive(data.active || []);
      } catch {}
    };

    fetch();
    const interval = setInterval(fetch, 3000);
    return () => clearInterval(interval);
  }, []);

  if (active.length === 0) return null;

  return (
    <div className="bg-blue-50 border-b border-blue-100 px-4 py-2">
      <div className="max-w-5xl mx-auto flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
          <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse inline-block"></span>
          {active.length} test{active.length > 1 ? 's' : ''} running
        </span>
        <div className="flex gap-2 flex-wrap">
          {active.map(t => (
            <Link
              key={t.test_id}
              href={`/results/${t.test_id}`}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-blue-200 rounded-full text-xs text-blue-700 hover:bg-blue-50 transition-colors"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                t.type === 'backend' ? 'bg-blue-400' : 'bg-purple-400'
              }`}></span>
              <span className="max-w-32 truncate">{t.target_url.replace(/https?:\/\//, '')}</span>
              <span className="text-blue-400">({t.type === 'backend' ? '⚡' : '🌐'})</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}