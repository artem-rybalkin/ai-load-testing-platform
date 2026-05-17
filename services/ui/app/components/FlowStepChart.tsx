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

const COLORS = ['#0969da', '#1f883d', '#9a6700', '#7c3aed', '#cf222e', '#0891b2', '#c2410c'];

const TOOLTIP_STYLE = {
  background: '#fff',
  border: '1px solid #d0d7de',
  borderRadius: '6px',
  fontSize: 11,
  fontFamily: 'monospace',
  boxShadow: 'none',
};

const TICK = { fill: '#57606a', fontSize: 11, fontFamily: 'monospace' };

export default function FlowStepChart({ steps }: { steps: StepMetric[] }) {
  const data = steps.map(s => ({
    name: s.name.length > 20 ? s.name.slice(0, 18) + '…' : s.name,
    fullName: s.name,
    avg: Math.round(s.avgResponseTime),
    p95: Math.round(s.p95ResponseTime),
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Response Time per Step</span>
        <span className="text-[10px] font-mono text-[#8c959f]">ms</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="#eaeef2" vertical={false} />
          <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
          <YAxis tick={TICK} unit="ms" width={50} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => [`${v}ms`, name === 'avg' ? 'Avg' : 'p95']}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ''}
            cursor={{ fill: '#f6f8fa' }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: 'monospace' }}
            formatter={(value) => value === 'avg' ? 'Avg response' : 'p95 response'}
          />
          <Bar dataKey="avg" name="avg" radius={[2, 2, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.55} />)}
          </Bar>
          <Bar dataKey="p95" name="p95" radius={[2, 2, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
