'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { TrendPoint } from '@/lib/api';

interface Props {
  trend: TrendPoint[];
  metricKey?: string;
  label?: string;
}

export default function TrendChart({ trend, metricKey = 'p95ResponseTime', label = 'p95 (ms)' }: Props) {
  const data = trend.map((p, i) => ({
    run: `#${i + 1}`,
    value: Math.round((p.metrics[metricKey] ?? 0) as number),
    perf_status: p.perf_status,
    date: new Date(p.created_at).toLocaleDateString(),
  }));

  const dotColor = (entry: { perf_status?: string }) =>
    entry.perf_status === 'failed' ? '#ef4444' : entry.perf_status === 'degraded' ? '#f59e0b' : '#22c55e';

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="run" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} unit="ms" />
        <Tooltip
          formatter={(v) => [`${v} ms`, label]}
          labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="value"
          name={label}
          stroke="#3b82f6"
          strokeWidth={2}
          dot={(props) => {
            const { cx, cy, payload } = props;
            return <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={4} fill={dotColor(payload)} stroke="#fff" strokeWidth={1} />;
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
