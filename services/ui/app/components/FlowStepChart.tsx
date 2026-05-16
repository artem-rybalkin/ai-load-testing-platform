'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell
} from 'recharts';

interface StepMetric {
  name: string;
  avgResponseTime: number;
  p95ResponseTime: number;
  requestsTotal: number;
  requestsFailed: number;
}

interface Props {
  steps: StepMetric[];
}

const COLORS = ['#3b82f6', '#f59e0b', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#f97316'];

export default function FlowStepChart({ steps }: Props) {
  const data = steps.map(s => ({
    name: s.name.length > 20 ? s.name.slice(0, 18) + '…' : s.name,
    fullName: s.name,
    avg: s.avgResponseTime,
    p95: s.p95ResponseTime,
  }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700">Response Time per Step</h3>
        <span className="text-xs text-gray-400">ms</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} unit="ms" width={52} />
          <Tooltip
            contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
            formatter={(v, name) => [`${v}ms`, name === 'avg' ? 'Avg' : 'p95']}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ''}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => value === 'avg' ? 'Avg response' : 'p95 response'}
          />
          <Bar dataKey="avg" name="avg" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.7} />
            ))}
          </Bar>
          <Bar dataKey="p95" name="p95" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
