'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell
} from 'recharts';

interface BackendMetrics {
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  rps: number;
}

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: 12,
  fontFamily: "'JetBrains Mono', monospace",
  boxShadow: 'none',
  color: 'var(--tx)',
};

const TICK = { fill: '#6b6557', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' };

export default function BackendChart({ metrics }: { metrics: BackendMetrics }) {
  const responseTimeData = [
    { name: 'Avg', value: Math.round(metrics.avgResponseTime), color: '#c9a063' },
    { name: 'p95', value: Math.round(metrics.p95ResponseTime), color: '#ff5a2c' },
    { name: 'p99', value: Math.round(metrics.p99ResponseTime), color: '#dc2626' },
  ];

  const requestsData = [
    { name: 'Success', value: metrics.requestsTotal - metrics.requestsFailed, color: '#16a34a' },
    { name: 'Failed',  value: metrics.requestsFailed,                          color: '#dc2626' },
  ];

  const errorRate = metrics.requestsTotal > 0
    ? ((metrics.requestsFailed / metrics.requestsTotal) * 100).toFixed(2)
    : '0';

  return (
    <div className="space-y-5">
      {/* Response Time */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Response Time</span>
          <span className="text-[10px] font-mono text-tx-4">milliseconds</span>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={responseTimeData} barSize={40}>
            <CartesianGrid stroke="#f2ede2" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
            <YAxis tick={TICK} unit="ms" width={48} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v) => [`${v}ms`, 'Response time']}
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: 'var(--hover)' }}
            />
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {responseTimeData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Requests breakdown */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Request breakdown</span>
          <span className="text-[10px] font-mono text-tx-4">Error rate: {errorRate}%</span>
        </div>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={requestsData} barSize={56}>
            <CartesianGrid stroke="#f2ede2" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
            <YAxis tick={TICK} width={48} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--hover)' }} />
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {requestsData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Throughput */}
      <div>
        <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase block mb-2.5">Throughput</span>
        <div className="flex items-end gap-2 mb-2">
          <span className="font-display text-[28px] font-bold leading-none">{metrics.rps?.toFixed(1)}</span>
          <span className="text-[13px] text-tx-3 mb-0.5">req/sec</span>
        </div>
        <div className="h-1.5 bg-line rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all"
            style={{ width: `${Math.min(100, (metrics.rps / 100) * 100)}%` }}
          />
        </div>
        <p className="text-[10px] font-mono text-tx-4 mt-1.5">relative to 100 rps baseline</p>
      </div>
    </div>
  );
}
