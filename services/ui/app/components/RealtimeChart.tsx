'use client';

import { memo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { LiveMetricPoint } from '@/lib/api';

interface Props {
  points: LiveMetricPoint[];
  startedAt?: string | null;
}

export const fmtElapsed = (iso: string, startedAt?: string | null): string => {
  if (!startedAt) return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const secs = Math.round((new Date(iso).getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${secs % 60 > 0 ? String(secs % 60).padStart(2, '0') + 's' : ''}`;
};

const STEP_COLORS = ['#ff5a2c', '#16a34a', '#ca8a04', '#7c3aed', '#dc2626', '#0891b2', '#c2410c'];

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

export const toKey = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

export const labelFor = (stepNames: string[], prefix: string, rawName: string) => {
  const key = String(rawName).replace(new RegExp(`^${prefix}_`), '');
  return stepNames.find(n => toKey(n) === key) ?? rawName;
};

const LEGEND_SHOW = 4;
const CHART_H = 224;

interface LegendProps {
  stepNames: string[];
  expanded: boolean;
  onToggle: () => void;
}

function StepLegend({ stepNames, expanded, onToggle }: LegendProps) {
  const visible = expanded ? stepNames : stepNames.slice(0, LEGEND_SHOW);
  const hiddenCount = stepNames.length - LEGEND_SHOW;
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {visible.map((name, i) => (
          <span key={name} className="inline-flex items-center gap-1 text-[11px] font-mono text-tx whitespace-nowrap">
            <span
              className="inline-block w-4 h-0.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: STEP_COLORS[i % STEP_COLORS.length] }}
            />
            {name}
          </span>
        ))}
        {stepNames.length > LEGEND_SHOW && (
          <button
            type="button"
            onClick={onToggle}
            className="text-[11px] font-mono text-accent hover:underline"
          >
            {expanded ? '↑ show fewer' : `+ ${hiddenCount} more step${hiddenCount > 1 ? 's' : ''}…`}
          </button>
        )}
      </div>
    </div>
  );
}

function RealtimeChart({ points, startedAt }: Props) {
  const [legendExpanded, setLegendExpanded] = useState(false);

  if (points.length === 0) {
    return (
      <div className="py-6 text-center">
        <div className="animate-pulse text-tx-4 text-[12px] font-mono">Waiting for first data point…</div>
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

  // The chart has no direct access to the admin-configured window size (it's a
  // producer-side setting, not persisted per-test) — derive it from consecutive
  // live-point timestamps instead, snapped to the nearest known bucket so poll
  // jitter never produces an odd label like "9.87s windows".
  const WINDOW_BUCKETS = [10, 30, 60] as const;
  const windowSec = points.length >= 2
    ? WINDOW_BUCKETS.reduce((best, b) => {
        const raw = (new Date(points[points.length - 1].timestamp).getTime()
                   - new Date(points[points.length - 2].timestamp).getTime()) / 1000;
        return Math.abs(b - raw) < Math.abs(best - raw) ? b : best;
      }, WINDOW_BUCKETS[0] as number)
    : null;
  const windowLabel = windowSec === 60 ? '1min windows' : windowSec ? `${windowSec}s windows` : 'live windows';

  const data = points.map(p => {
    const row: Record<string, number | string> = {
      t:               fmtElapsed(p.timestamp, startedAt),
      vus:             p.vus,
      rps:             p.rps,
      avgResponseTime: p.avgResponseTime,
      errorRate:       p.errorRate,
      clientErrorRate: p.clientErrorRate ?? 0,
      serverErrorRate: p.serverErrorRate ?? 0,
    };
    p.stepMetrics?.forEach(s => {
      const k = toKey(s.name);
      row[`avg_${k}`] = s.avgResponseTime;
      row[`rps_${k}`] = s.rps;
      row[`err_${k}`] = s.errorRate;
    });
    return row;
  });

  const toggle = () => setLegendExpanded(e => !e);

  return (
    <div className="space-y-4">
      {/* ── Response time ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">
            {hasSteps ? 'Response Time per Step' : 'Response Time'}
          </span>
          <span className="text-[10px] font-mono text-tx-4">ms · {windowLabel}</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <LineChart data={data}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="t" tick={TICK} interval="preserveStartEnd" axisLine={false} tickLine={false} />
            <YAxis tick={TICK} unit="ms" width={50} domain={[0, 'auto']} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v, name) => [`${v}ms`, hasSteps ? labelFor(stepNames, 'avg', String(name)) : 'Avg response']}
            />
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`avg_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={1.5}
                dot={false} isAnimationActive={false} name={`avg_${toKey(name)}`} connectNulls />
            )) : (
              <Line type="monotone" dataKey="avgResponseTime"
                stroke="#ff5a2c" strokeWidth={1.5} dot={false} name="Avg response" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Error rate ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">
            {hasSteps ? 'Error Rate per Step' : 'Error Rate'}
          </span>
          <span className="text-[10px] font-mono text-tx-4">error %</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <LineChart data={data}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="t" tick={TICK} interval="preserveStartEnd" axisLine={false} tickLine={false} />
            <YAxis tick={TICK} unit="%" width={42} domain={[0, (max: number) => Math.max(max, 1)]} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v, name) => [`${v}%`, hasSteps ? labelFor(stepNames, 'err', String(name)) : String(name)]}
            />
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`err_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={1.5}
                dot={false} isAnimationActive={false} name={`err_${toKey(name)}`} connectNulls />
            )) : (
              <>
                {/* Dashed + drawn last so "total" stays visible even when it exactly
                    overlaps a component line below (e.g. a run with only 4xx errors) */}
                <Line type="monotone" dataKey="clientErrorRate"
                  stroke="#ca8a04" strokeWidth={1.5} dot={false} name="Client error (4xx)" />
                <Line type="monotone" dataKey="serverErrorRate"
                  stroke="#991b1b" strokeWidth={1.5} dot={false} name="Server error (5xx)" />
                <Line type="monotone" dataKey="errorRate"
                  stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="Error rate (total)" />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
        {!hasSteps && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
            {[
              { label: 'Client error (4xx)', color: '#ca8a04' },
              { label: 'Server error (5xx)', color: '#991b1b' },
              { label: 'Error rate (total)', color: '#dc2626', dashed: true },
            ].map(item => (
              <span key={item.label} className="inline-flex items-center gap-1 text-[11px] font-mono text-tx whitespace-nowrap">
                <span
                  className="inline-block w-4 h-0.5 rounded-full flex-shrink-0"
                  style={item.dashed
                    ? { backgroundImage: `repeating-linear-gradient(to right, ${item.color} 0 4px, transparent 4px 6px)` }
                    : { backgroundColor: item.color }}
                />
                {item.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Virtual users ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">Virtual Users</span>
          <span className="text-[10px] font-mono text-tx-4">VUs</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <LineChart data={data}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="t" tick={TICK} interval="preserveStartEnd" axisLine={false} tickLine={false} />
            <YAxis tick={TICK} width={34} domain={[0, 'auto']} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}`, 'VUs']} />
            <Line type="monotone" dataKey="vus" stroke="#16a34a" strokeWidth={1.5} dot={false} name="VUs" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Throughput ────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">
            {hasSteps ? 'Throughput per Step' : 'Throughput'}
          </span>
          <span className="text-[10px] font-mono text-tx-4">req/sec</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <LineChart data={data}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="t" tick={TICK} interval="preserveStartEnd" axisLine={false} tickLine={false} />
            <YAxis tick={TICK} unit=" rps" width={52} domain={[0, 'auto']} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v, name) => [`${v} rps`, hasSteps ? labelFor(stepNames, 'rps', String(name)) : 'RPS']}
            />
            {hasSteps ? stepNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={`rps_${toKey(name)}`}
                stroke={STEP_COLORS[i % STEP_COLORS.length]} strokeWidth={1.5}
                dot={false} isAnimationActive={false} name={`rps_${toKey(name)}`} connectNulls />
            )) : (
              <Line type="monotone" dataKey="rps"
                stroke="#7c3aed" strokeWidth={1.5} dot={false} name="RPS" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* One shared legend for all three per-step panels above — they use the
          same step names/colors, so repeating it under each panel was pure
          duplication. */}
      {hasSteps && <StepLegend stepNames={stepNames} expanded={legendExpanded} onToggle={toggle} />}
    </div>
  );
}

// The parent page re-renders every second (elapsed/countdown timers) even
// when no new live metric has arrived — memoize so this component (and the
// Recharts SVG rebuild it triggers) only redoes work when points/startedAt
// actually change.
export default memo(RealtimeChart);
