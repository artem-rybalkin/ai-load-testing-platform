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
  background: '#fff',
  border: '1px solid #d0d7de',
  borderRadius: '6px',
  fontSize: 12,
  fontFamily: 'monospace',
  boxShadow: 'none',
};

const TICK = { fill: '#57606a', fontSize: 11, fontFamily: 'monospace' };

export default function BackendChart({ metrics }: { metrics: BackendMetrics }) {
  const responseTimeData = [
    { name: 'Avg', value: Math.round(metrics.avgResponseTime), color: '#0969da' },
    { name: 'p95', value: Math.round(metrics.p95ResponseTime), color: '#9a6700' },
    { name: 'p99', value: Math.round(metrics.p99ResponseTime), color: '#cf222e' },
  ];

  const requestsData = [
    { name: 'Success', value: metrics.requestsTotal - metrics.requestsFailed, color: '#1f883d' },
    { name: 'Failed',  value: metrics.requestsFailed,                          color: '#cf222e' },
  ];

  const errorRate = metrics.requestsTotal > 0
    ? ((metrics.requestsFailed / metrics.requestsTotal) * 100).toFixed(2)
    : '0';

  return (
    <div className="space-y-4">
      {/* Response Time */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Response Time</span>
          <span className="text-[10px] font-mono text-[#8c959f]">milliseconds</span>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={responseTimeData} barSize={40}>
            <CartesianGrid stroke="#eaeef2" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
            <YAxis tick={TICK} unit="ms" width={48} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v) => [`${v}ms`, 'Response time']}
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: '#f6f8fa' }}
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
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Request breakdown</span>
          <span className="text-[10px] font-mono text-[#8c959f]">Error rate: {errorRate}%</span>
        </div>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={requestsData} barSize={56}>
            <CartesianGrid stroke="#eaeef2" vertical={false} />
            <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
            <YAxis tick={TICK} width={48} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#f6f8fa' }} />
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
        <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide block mb-2">Throughput</span>
        <div className="flex items-end gap-2 mb-2">
          <span className="text-[28px] font-mono font-bold text-[#24292f] leading-none">{metrics.rps?.toFixed(1)}</span>
          <span className="text-[13px] text-[#57606a] mb-0.5">req/sec</span>
        </div>
        <div className="h-1.5 bg-[#eaeef2] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#0969da] rounded-full transition-all"
            style={{ width: `${Math.min(100, (metrics.rps / 100) * 100)}%` }}
          />
        </div>
        <p className="text-[10px] font-mono text-[#8c959f] mt-1">relative to 100 rps baseline</p>
      </div>
    </div>
  );
}
