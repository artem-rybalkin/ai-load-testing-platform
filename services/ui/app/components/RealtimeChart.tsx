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

const STEP_COLORS = ['#3b82f6', '#f59e0b', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#f97316'];

const toKey = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

const labelFor = (stepNames: string[], prefix: string, rawName: string) => {
  const key = String(rawName).replace(new RegExp(`^${prefix}_`), '');
  return stepNames.find(n => toKey(n) === key) ?? rawName;
};

export default function RealtimeChart({ points, startedAt }: Props) {
  if (points.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <div className="animate-pulse text-gray-400 text-sm">Waiting for first data point...</div>
      </div>
    );
  }

  const stepNames: string[] = [];
  for (const p of points) {
    for (const s of p.stepMetrics ?? []) {
      if (!stepNames.includes(s.name)) stepNames.push(s.name);
    }
  }
  const hasSteps = stepNames.length > 0;

  const data = points.map(p => {
    const row: Record<string, number | string> = {
      t:               fmtElapsed(p.timestamp, startedAt),
      vus:             p.vus,
      rps:             p.rps,
      avgResponseTime: p.avgResponseTime,
      errorRate:       p.errorRate,
    };
    p.stepMetrics?.forEach(s => {
      const k = toKey(s.name);
      row[`avg_${k}`] = s.avgResponseTime;
      row[`rps_${k}`] = s.rps;
      row[`err_${k}`] = s.errorRate;
    });
    return row;
  });

  return (
    <div className="space-y-4">
      {/* Response time */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            {hasSteps ? 'Response Time per Step (live)' : 'Response Time (live)'}
          </h3>
          <span className="text-xs text-gray-400">ms · updates every 5s</span>
        </div>
        <ResponsiveContainer width="100%" height={hasSteps ? 220 : 180}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} unit="ms" width={52} domain={[0, 'auto']} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
              formatter={(v, name) => [`${v}ms`, labelFor(stepNames, 'avg', String(name))]}
            />
            {hasSteps && <Legend wrapperStyle={{ fontSize: 11 }} formatter={name => labelFor(stepNames, 'avg', String(name))} />}
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`avg_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={2}
                dot={false} name={`avg_${toKey(name)}`} connectNulls />
            )) : (
              <Line type="monotone" dataKey="avgResponseTime"
                stroke="#3b82f6" strokeWidth={2} dot={false} name="Avg response" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Error rate */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            {hasSteps ? 'Error Rate per Step (live)' : 'Virtual Users & Error Rate (live)'}
          </h3>
          <span className="text-xs text-gray-400">{hasSteps ? 'error % per step' : 'VUs left · error % right'}</span>
        </div>
        <ResponsiveContainer width="100%" height={hasSteps ? 160 : 180}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            {hasSteps ? (
              <YAxis tick={{ fontSize: 11 }} unit="%" width={44}
                domain={[0, (max: number) => Math.max(max, 1)]} />
            ) : (
              <>
                <YAxis yAxisId="vus" tick={{ fontSize: 11 }} width={36} />
                <YAxis yAxisId="err" orientation="right" tick={{ fontSize: 11 }} unit="%" width={44} />
              </>
            )}
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
              formatter={(v, name) => {
                if (hasSteps) return [`${v}%`, labelFor(stepNames, 'err', String(name))];
                return name === 'VUs' ? [`${v}`, 'VUs'] : [`${v}%`, 'Error rate'];
              }}
            />
            {hasSteps && <Legend wrapperStyle={{ fontSize: 12 }} formatter={name => labelFor(stepNames, 'err', String(name))} />}
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`err_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={2}
                dot={false} name={`err_${toKey(name)}`} connectNulls />
            )) : (
              <>
                <Line yAxisId="vus" type="monotone" dataKey="vus"
                  stroke="#22c55e" strokeWidth={2} dot={false} name="VUs" />
                <Line yAxisId="err" type="monotone" dataKey="errorRate"
                  stroke="#ef4444" strokeWidth={2} dot={false} name="Error rate" />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Throughput */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            {hasSteps ? 'Throughput per Step (live)' : 'Throughput (live)'}
          </h3>
          <span className="text-xs text-gray-400">requests / sec</span>
        </div>
        <ResponsiveContainer width="100%" height={hasSteps ? 200 : 140}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="t" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} unit=" rps" width={56} domain={[0, 'auto']} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }}
              formatter={(v, name) => [`${v} rps`, labelFor(stepNames, 'rps', String(name))]}
            />
            {hasSteps && <Legend wrapperStyle={{ fontSize: 11 }} formatter={name => labelFor(stepNames, 'rps', String(name))} />}
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`rps_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={2}
                dot={false} name={`rps_${toKey(name)}`} connectNulls />
            )) : (
              <Line type="monotone" dataKey="rps"
                stroke="#a855f7" strokeWidth={2} dot={false} name="RPS" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
