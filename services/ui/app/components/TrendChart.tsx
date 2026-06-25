'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts';
import { TrendPoint } from '@/lib/api';

interface Props {
  trend: TrendPoint[];
  metricKey?: string;
  label?: string;
}

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  boxShadow: 'none',
  color: 'var(--tx)',
};

const TICK = { fill: '#6b6557', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' };

export default function TrendChart({ trend, metricKey = 'p95ResponseTime', label = 'p95 (ms)' }: Props) {
  const data = trend.map((p, i) => ({
    run: `#${i + 1}`,
    value: Math.round((p.metrics[metricKey] ?? 0) as number),
    perf_status: p.perf_status,
    date: new Date(p.created_at).toLocaleDateString(),
  }));

  const dotColor = (entry: { perf_status?: string }) =>
    entry.perf_status === 'failed'   ? '#dc2626' :
    entry.perf_status === 'degraded' ? '#ca8a04' :
    '#16a34a';

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#f2ede2" vertical={false} />
        <XAxis dataKey="run" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tick={TICK} unit="ms" axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v) => [`${v} ms`, label]}
          labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={label}
          stroke="#ff5a2c"
          strokeWidth={1.5}
          dot={(props) => {
            const { cx, cy, payload } = props;
            return <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill={dotColor(payload)} stroke="var(--surface)" strokeWidth={1.5} />;
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
