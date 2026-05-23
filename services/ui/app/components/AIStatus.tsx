'use client';

import { useEffect, useState } from 'react';
import { getAIStatus } from '@/lib/api';

const STORAGE_KEY = 'aiStatusDismissedAt';

export default function AIStatus() {
  const [exceeded, setExceeded] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number>(0);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setDismissedAt(Number(stored));
    } catch { /* private browsing */ }

    const check = async () => {
      try {
        const data = await getAIStatus();
        if (data.quotaExceeded) {
          // Re-show if quota was hit after last dismissal
          const sinceMs = data.since ? new Date(data.since).getTime() : Date.now();
          const dismissed = (() => { try { return Number(localStorage.getItem(STORAGE_KEY) || 0); } catch { return 0; } })();
          setExceeded(sinceMs > dismissed);
        } else {
          setExceeded(false);
        }
      } catch { /* ignore */ }
    };

    check();
    const interval = setInterval(check, 60_000);
    return () => clearInterval(interval);
  }, []);

  const dismiss = () => {
    const now = Date.now();
    try { localStorage.setItem(STORAGE_KEY, String(now)); } catch { /* private browsing */ }
    setDismissedAt(now);
    setExceeded(false);
  };

  if (!exceeded) return null;

  return (
    <div className="bg-[#fff8c5] border-b border-[#e3b341] px-4 py-2 flex items-start gap-3">
      <span className="text-[#9a6700] text-[13px] mt-0.5 shrink-0">⚠</span>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-semibold text-[#9a6700]">Gemini API — досягнуто денного ліміту</span>
        <p className="text-[11px] font-mono text-[#9a6700] mt-0.5">
          Генерація нових скриптів недоступна до скидання квоти (опівніч за UTC).
          Тести з кешованими скриптами продовжують працювати.
        </p>
      </div>
      <button
        onClick={dismiss}
        className="text-[#9a6700] hover:text-[#7a5100] text-[14px] shrink-0 leading-none"
        aria-label="Закрити"
      >
        ×
      </button>
    </div>
  );
}
