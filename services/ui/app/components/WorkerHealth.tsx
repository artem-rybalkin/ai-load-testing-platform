'use client';

import { useEffect, useState } from 'react';
import { ServiceHealth, getTeamQuota } from '@/lib/api';
import { useHealth } from '@/lib/HealthContext';
import { useAuth } from '@/lib/AuthContext';

const WORKER_NAMES: Record<string, string> = {
  'worker-backend': '⚡ k6',
  'worker-client':  '🌐 Browser',
};

const barColor = (pct: number) =>
  pct >= 80 ? 'bg-[#cf222e]' : pct >= 60 ? 'bg-[#9a6700]' : 'bg-[#1f883d]';

const MiniBar = ({ value, max = 100, label }: { value: number; max?: number; label: string }) => {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-mono text-[#57606a] w-8 shrink-0">{label}</span>
      <div className="w-14 h-1.5 bg-[#eaeef2] rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-[#57606a] w-7 shrink-0">{pct}%</span>
    </div>
  );
};

export default function WorkerHealth() {
  const { services } = useHealth();
  const { user } = useAuth();
  const workers = services.filter(s => WORKER_NAMES[s.name] && s.metrics);

  const teamId = user?.currentTeamId;
  const [geminiUsage, setGeminiUsage] = useState<{ used: number; max: number } | null>(null);

  useEffect(() => {
    if (!teamId) { setGeminiUsage(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const { quota, usage } = await getTeamQuota(teamId);
        if (!cancelled) setGeminiUsage({ used: usage.geminiCallsToday, max: quota.maxGeminiCallsPerDay });
      } catch { /* non-fatal */ }
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId]);

  if (workers.length === 0 && !geminiUsage) return null;

  return (
    <div className="border-b border-[#eaeef2] bg-[#f6f7f8] px-4 py-1.5">
      <div className="flex items-center gap-6 flex-wrap">
        {workers.map(w => {
          const m = w.metrics!;
          const saturated = w.status === 'saturated';
          const unreachable = w.status === 'unreachable';
          return (
            <div key={w.name} className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  unreachable ? 'bg-[#8c959f]' : saturated ? 'bg-[#cf222e]' : 'bg-[#1f883d]'
                }`} />
                <span className="text-[11px] font-mono font-medium text-[#24292f]">
                  {WORKER_NAMES[w.name]}
                </span>
              </div>
              {!unreachable && (
                <>
                  <MiniBar value={m.cpuPercent} label="CPU" />
                  <MiniBar value={m.memoryPercent} label="MEM" />
                  <span className={`text-[10px] font-mono ${saturated ? 'text-[#cf222e] font-semibold' : 'text-[#57606a]'}`}>
                    {m.activeTests}/{m.maxTests} tests
                  </span>
                </>
              )}
              {unreachable && (
                <span className="text-[10px] font-mono text-[#8c959f]">offline</span>
              )}
            </div>
          );
        })}
        {geminiUsage && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono font-medium text-[#24292f]">Gemini</span>
            <span className={`text-[10px] font-mono ${geminiUsage.used >= geminiUsage.max ? 'text-[#cf222e] font-semibold' : 'text-[#57606a]'}`}>
              {geminiUsage.used}/{geminiUsage.max} today
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
