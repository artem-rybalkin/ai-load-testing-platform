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

// Orange/amber get a dedicated dark-mode step (--chart-orange/--chart-amber in
// globals.css) — their light-mode hex sits just above the dark OKLCH lightness
// band [0.48, 0.67], validated via the dataviz skill's validate_palette.js.
const STEP_COLORS = ['var(--chart-orange)', '#16a34a', 'var(--chart-amber)', '#7c3aed', '#dc2626', '#0891b2', '#c2410c'];

// The worst adjacent pair (step 0 orange <-> step 1 green) sits in the CVD
// floor band (ΔE 10, validate_palette.js) — legal only with secondary
// encoding. Alternating solid/dashed strokes by index means any two adjacent
// steps differ in pattern as well as hue, so they stay distinguishable even
// under color-vision deficiency or in grayscale.
const STEP_DASH = '4 2';
const isDashedStep = (i: number): boolean => i % 2 === 1;

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
        {visible.map((name, i) => {
          const color = STEP_COLORS[i % STEP_COLORS.length];
          const dashed = isDashedStep(i % STEP_COLORS.length);
          return (
            <span key={name} className="inline-flex items-center gap-1 text-[11px] font-mono text-tx whitespace-nowrap">
              <span
                className="inline-block w-4 h-0.5 rounded-full flex-shrink-0"
                style={dashed
                  ? { backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 6px)` }
                  : { backgroundColor: color }}
              />
              {name}
            </span>
          );
        })}
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

interface TableRow {
  t: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
  clientErrorRate: number;
  serverErrorRate: number;
  [key: string]: number | string;
}

/**
 * Accessible table twin of the charts above — color-only encoding on a
 * continuous scale (the per-step line colors, the amber client-4xx line
 * sitting below the 3:1 contrast floor) needs a non-color-dependent
 * alternative per the dataviz skill's accessibility pass.
 */
function TableView({ data, stepNames, hasSteps }: { data: TableRow[]; stepNames: string[]; hasSteps: boolean }) {
  return (
    <div className="overflow-x-auto border border-border rounded-card">
      <table className="w-full">
        <thead>
          <tr className="bg-surface-2 border-b border-border">
            {(hasSteps
              ? ['Time', ...stepNames.flatMap(n => [`${n} avg ms`, `${n} err %`, `${n} rps`])]
              : ['Time', 'Avg ms', 'Error % (total)', 'Client 4xx %', 'Server 5xx %', 'VUs', 'RPS']
            ).map(h => (
              <th key={h} className="py-2.5 px-4 font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase text-right first:text-left whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-3">
          {data.map((row, i) => (
            <tr key={i} className="hover:bg-hover">
              <td className="py-2 px-4 font-mono text-[12.5px] text-tx-3">{row.t}</td>
              {hasSteps
                ? stepNames.flatMap(n => {
                    const k = toKey(n);
                    return [
                      <td key={`${n}-avg`} className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{Math.round(Number(row[`avg_${k}`] ?? 0))}</td>,
                      <td key={`${n}-err`} className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{Number(row[`err_${k}`] ?? 0).toFixed(1)}</td>,
                      <td key={`${n}-rps`} className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{Number(row[`rps_${k}`] ?? 0).toFixed(1)}</td>,
                    ];
                  })
                : (
                  <>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{Math.round(row.avgResponseTime)}</td>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{row.errorRate.toFixed(1)}</td>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{row.clientErrorRate.toFixed(1)}</td>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{row.serverErrorRate.toFixed(1)}</td>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{row.vus}</td>
                    <td className="py-2 px-4 text-right font-mono text-[12.5px] text-tx-3">{row.rps.toFixed(1)}</td>
                  </>
                )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RealtimeChart({ points, startedAt }: Props) {
  const [legendExpanded, setLegendExpanded] = useState(false);
  const [tableView, setTableView] = useState(false);

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
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setTableView(v => !v)}
          className="text-[11px] font-mono text-accent hover:underline"
        >
          {tableView ? '📈 Chart view' : '📋 Table view'}
        </button>
      </div>

      {tableView && <TableView data={data as TableRow[]} stepNames={stepNames} hasSteps={hasSteps} />}

      {!tableView && (
      <>
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
                strokeDasharray={isDashedStep(i % STEP_COLORS.length) ? STEP_DASH : undefined}
                dot={false} isAnimationActive={false} name={`avg_${toKey(name)}`} connectNulls />
            )) : (
              <Line type="monotone" dataKey="avgResponseTime"
                stroke="var(--chart-orange)" strokeWidth={1.5} dot={false} name="Avg response" />
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
                strokeDasharray={isDashedStep(i % STEP_COLORS.length) ? STEP_DASH : undefined}
                dot={false} isAnimationActive={false} name={`err_${toKey(name)}`} connectNulls />
            )) : (
              <>
                {/* Dashed + drawn last so "total" stays visible even when it exactly
                    overlaps a component line below (e.g. a run with only 4xx errors) */}
                <Line type="monotone" dataKey="clientErrorRate"
                  stroke="var(--chart-amber)" strokeWidth={1.5} dot={false} name="Client error (4xx)" />
                <Line type="monotone" dataKey="serverErrorRate"
                  stroke="var(--chart-red-dark)" strokeWidth={1.5} dot={false} name="Server error (5xx)" />
                <Line type="monotone" dataKey="errorRate"
                  stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="Error rate (total)" />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
        {!hasSteps && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
            {[
              { label: 'Client error (4xx)', color: 'var(--chart-amber)' },
              { label: 'Server error (5xx)', color: 'var(--chart-red-dark)' },
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
                strokeDasharray={isDashedStep(i % STEP_COLORS.length) ? STEP_DASH : undefined}
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
      </>
      )}
    </div>
  );
}

// The parent page re-renders every second (elapsed/countdown timers) even
// when no new live metric has arrived — memoize so this component (and the
// Recharts SVG rebuild it triggers) only redoes work when points/startedAt
// actually change.
export default memo(RealtimeChart);
