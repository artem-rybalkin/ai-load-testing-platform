'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { LiveMetricPoint } from '@/lib/api';

interface Props {
  points: LiveMetricPoint[];
  startedAt?: string | null;
}

const fmtElapsed = (iso: string, startedAt?: string | null): string => {
  if (!startedAt) return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const secs = Math.round((new Date(iso).getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${secs % 60 > 0 ? String(secs % 60).padStart(2, '0') + 's' : ''}`;
};

export default function RealtimeChart({ points, startedAt }: Props) {
  if (points.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <div className="animate-pulse text-gray-400 text-sm">Waiting for first data point...</div>
      </div>
    );
  }

  const data = points.map(p => ({ ...p, t: fmtElapsed(p.timestamp, startedAt) }));

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">Response Time (live)</h3>
          <span className="text-xs text-gray-400">ms · updates every 5s</span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} unit="ms" width={52} />
            <Tooltip
              formatter={(v) => [`${v}ms`, 'Avg response']}
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
            />
            <Line
              type="monotone"
              dataKey="avgResponseTime"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              name="Avg response"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">Virtual Users &amp; Error Rate (live)</h3>
          <span className="text-xs text-gray-400">VUs left · error % right</span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis yAxisId="vus" tick={{ fontSize: 11 }} width={36} />
            <YAxis yAxisId="err" orientation="right" tick={{ fontSize: 11 }} unit="%" width={44} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              yAxisId="vus"
              type="monotone"
              dataKey="vus"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              name="VUs"
            />
            <Line
              yAxisId="err"
              type="monotone"
              dataKey="errorRate"
              stroke="#ef4444"
              strokeWidth={2}
              dot={false}
              name="Error rate"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">Throughput (live)</h3>
          <span className="text-xs text-gray-400">requests / sec</span>
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} unit=" rps" width={56} />
            <Tooltip
              formatter={(v) => [`${v} rps`, 'Throughput']}
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
            />
            <Line
              type="monotone"
              dataKey="rps"
              stroke="#a855f7"
              strokeWidth={2}
              dot={false}
              name="RPS"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
