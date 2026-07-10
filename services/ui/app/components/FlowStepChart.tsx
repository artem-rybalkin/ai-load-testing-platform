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

const COLORS = ['#ff5a2c', '#16a34a', '#ca8a04', '#7c3aed', '#dc2626', '#0891b2', '#c2410c'];

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  boxShadow: 'none',
  color: 'var(--tx)',
};

const TICK = { fill: 'var(--tx-3)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' };
const GRID_STROKE = 'var(--border-2)';

export default function FlowStepChart({ steps }: { steps: StepMetric[] }) {
  const data = steps.map(s => ({
    name: s.name.length > 20 ? s.name.slice(0, 18) + '…' : s.name,
    fullName: s.name,
    avg: Math.round(s.avgResponseTime),
    p95: Math.round(s.p95ResponseTime),
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Response Time per Step</span>
        <span className="text-[10px] font-mono text-tx-4">ms</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="name" tick={TICK} axisLine={false} tickLine={false} />
          <YAxis tick={TICK} unit="ms" width={50} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => [`${v}ms`, name === 'avg' ? 'Avg' : 'p95']}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName ?? ''}
            cursor={{ fill: 'var(--hover)' }}
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
