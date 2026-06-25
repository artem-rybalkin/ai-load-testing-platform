'use client';

import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  ResponsiveContainer, Tooltip
} from 'recharts';

interface LighthouseScore {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

interface ResourceBreakdown {
  jsSize: number; cssSize: number; imageSize: number;
  fontSize: number; xhrSize: number; totalSize: number; requestCount: number;
}

interface ClientMetrics {
  lcp: number; fcp: number; ttfb: number; fid: number; cls: number;
  inp?: number; tbt?: number; tti?: number;
  jsErrors?: number; longTaskCount?: number; domNodeCount?: number; pageLoadCount?: number;
  resourceBreakdown?: ResourceBreakdown;
  lighthouseScore?: LighthouseScore;
}

const vitalThresholds = {
  lcp:  { good: 2500, poor: 4000 },
  fcp:  { good: 1800, poor: 3000 },
  ttfb: { good: 800,  poor: 1800 },
  fid:  { good: 100,  poor: 300  },
  inp:  { good: 200,  poor: 500  },
  tbt:  { good: 200,  poor: 600  },
};

export const getVitalStatus = (key: string, value: number): 'good' | 'needs-improvement' | 'poor' => {
  const t = vitalThresholds[key as keyof typeof vitalThresholds];
  if (!t) return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
};

const statusCls = {
  'good':              'text-green-fg-2 bg-green-bg',
  'needs-improvement': 'text-amber-badge-fg bg-amber-bg',
  'poor':              'text-red-badge-fg bg-red-bg',
};

const statusLabel = { 'good': 'Good', 'needs-improvement': 'Needs work', 'poor': 'Poor' };

const VitalCard = ({ label, value, unit, metricKey }: {
  label: string; value: number; unit: string; metricKey: string;
}) => {
  const status = getVitalStatus(metricKey, value);
  return (
    <div className="bg-bg border border-border rounded-control p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase">{label}</p>
        <span className={`text-[10px] px-1.5 rounded-chip font-mono font-medium ${statusCls[status]}`}>
          {statusLabel[status]}
        </span>
      </div>
      <p className="font-display text-[20px] font-bold leading-none">
        {metricKey === 'cls' ? value.toFixed(3) : Math.round(value)}
        <span className="text-[11px] font-sans font-normal text-tx-4 ml-1">{unit}</span>
      </p>
    </div>
  );
};

const InfoRow = ({ label, value }: { label: string; value: string | number }) => (
  <div className="flex items-center justify-between py-2 border-b border-line last:border-0">
    <span className="text-[12px] text-tx-3">{label}</span>
    <span className="text-[12px] font-mono font-medium">{value}</span>
  </div>
);

export const lhColor = (score: number) =>
  score >= 90 ? '#16a34a' : score >= 50 ? '#ca8a04' : '#dc2626';

export const lhCls = (score: number) =>
  score >= 90 ? 'text-green-fg-2 bg-green-bg' : score >= 50 ? 'text-amber-badge-fg bg-amber-bg' : 'text-red-badge-fg bg-red-bg';

const ScoreGauge = ({ score, label }: { score: number; label: string }) => {
  const color = lhColor(score);
  const c = 2 * Math.PI * 16;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-14 h-14">
        <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
          <circle cx="18" cy="18" r="16" fill="none" stroke="#f2ede2" strokeWidth="3" />
          <circle cx="18" cy="18" r="16" fill="none" stroke={color} strokeWidth="3"
            strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[13px] font-bold">
          {score}
        </span>
      </div>
      <span className="text-[10.5px] text-tx-3 text-center leading-tight">{label}</span>
      <span className={`text-[9px] px-1.5 py-0.5 rounded-chip font-mono font-medium ${lhCls(score)}`}>
        {score >= 90 ? 'Good' : score >= 50 ? 'Needs work' : 'Poor'}
      </span>
    </div>
  );
};

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  boxShadow: 'none',
  color: 'var(--tx)',
};

export default function ClientChart({ metrics }: { metrics: ClientMetrics }) {
  // INP is the current Core Web Vital (replaced FID March 2024); include both in radar
  const radarData = [
    { metric: 'LCP',  score: Math.max(0, 100 - (metrics.lcp  / 4000) * 100) },
    { metric: 'FCP',  score: Math.max(0, 100 - (metrics.fcp  / 3000) * 100) },
    { metric: 'TTFB', score: Math.max(0, 100 - (metrics.ttfb / 1800) * 100) },
    { metric: 'INP',  score: metrics.inp != null ? Math.max(0, 100 - (metrics.inp / 500) * 100) : Math.max(0, 100 - (metrics.fid / 300) * 100) },
    { metric: 'CLS',  score: Math.max(0, 100 - (metrics.cls  / 0.25) * 100) },
  ];
  const overallScore = Math.round(radarData.reduce((s, d) => s + d.score, 0) / radarData.length);
  const lh = metrics.lighthouseScore;

  return (
    <div className="space-y-5">
      {/* Overall score */}
      <div className="flex items-center gap-4 p-4 bg-bg border border-border rounded-control">
        <div className="relative w-16 h-16 flex-shrink-0">
          <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
            <circle cx="18" cy="18" r="16" fill="none" stroke="#f2ede2" strokeWidth="3" />
            <circle cx="18" cy="18" r="16" fill="none"
              stroke={overallScore >= 70 ? '#16a34a' : overallScore >= 50 ? '#ca8a04' : '#dc2626'}
              strokeWidth="3"
              strokeDasharray={`${overallScore} 100`}
              strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[15px] font-bold">
            {overallScore}
          </span>
        </div>
        <div>
          <p className="text-[13.5px] font-semibold">Web Vitals Score</p>
          <p className="text-[11.5px] text-tx-3 mt-0.5">Based on Core Web Vitals thresholds</p>
          <p className="text-[11px] font-mono mt-1 text-tx-3">
            {overallScore >= 70 ? '● Good' : overallScore >= 50 ? '● Needs improvement' : '● Poor'}
          </p>
        </div>
      </div>

      {/* Radar */}
      <div>
        <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase block mb-2.5">Web Vitals Radar</span>
        <ResponsiveContainer width="100%" height={200}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="#f2ede2" />
            <PolarAngleAxis dataKey="metric" tick={{ fill: '#6b6557', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }} />
            <Radar dataKey="score" stroke="#ff5a2c" fill="#ff5a2c" fillOpacity={0.12} strokeWidth={1.5} />
            <Tooltip
              formatter={(v) => [`${Math.round(Number(v))}`, 'Score']}
              contentStyle={TOOLTIP_STYLE}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Core Web Vitals */}
      <div>
        <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase block mb-2.5">Core Web Vitals</span>
        <div className="grid grid-cols-2 gap-2.5">
          <VitalCard label="LCP"  value={metrics.lcp}  unit="ms" metricKey="lcp" />
          <VitalCard label="FCP"  value={metrics.fcp}  unit="ms" metricKey="fcp" />
          <VitalCard label="TTFB" value={metrics.ttfb} unit="ms" metricKey="ttfb" />
          <VitalCard label="CLS"  value={metrics.cls}  unit=""   metricKey="cls" />
          {metrics.inp != null && <VitalCard label="INP" value={metrics.inp} unit="ms" metricKey="inp" />}
          {metrics.tbt != null && <VitalCard label="TBT" value={metrics.tbt} unit="ms" metricKey="tbt" />}
          {metrics.fid > 0 && <VitalCard label="FID (legacy)" value={metrics.fid} unit="ms" metricKey="fid" />}
        </div>
      </div>

      {/* Additional timing & page health */}
      {(metrics.tti != null || metrics.jsErrors != null || metrics.longTaskCount != null || metrics.domNodeCount != null || metrics.pageLoadCount != null) && (
        <div>
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase block mb-2.5">Page Health</span>
          <div className="bg-bg border border-border rounded-control px-3.5 py-1">
            {metrics.tti        != null && <InfoRow label="Time to Interactive (TTI)" value={`${Math.round(metrics.tti)} ms`} />}
            {metrics.longTaskCount != null && <InfoRow label="Long Tasks (>50ms)"        value={metrics.longTaskCount} />}
            {metrics.jsErrors   != null && <InfoRow label="JS Errors"                  value={metrics.jsErrors} />}
            {metrics.domNodeCount != null && <InfoRow label="DOM Nodes"                  value={metrics.domNodeCount.toLocaleString()} />}
            {metrics.pageLoadCount != null && <InfoRow label="Page Opens"                 value={metrics.pageLoadCount} />}
          </div>
        </div>
      )}

      {/* Resource breakdown */}
      {metrics.resourceBreakdown && (
        <div>
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase block mb-2.5">
            Resource Breakdown
            <span className="ml-2 font-sans font-normal text-tx-4">
              {metrics.resourceBreakdown.requestCount} requests · {metrics.resourceBreakdown.totalSize.toFixed(1)} KB total
            </span>
          </span>
          <div className="bg-bg border border-border rounded-control px-3.5 py-1">
            <InfoRow label="JavaScript"  value={`${metrics.resourceBreakdown.jsSize.toFixed(1)} KB`} />
            <InfoRow label="CSS"         value={`${metrics.resourceBreakdown.cssSize.toFixed(1)} KB`} />
            <InfoRow label="Images"      value={`${metrics.resourceBreakdown.imageSize.toFixed(1)} KB`} />
            <InfoRow label="Fonts"       value={`${metrics.resourceBreakdown.fontSize.toFixed(1)} KB`} />
            <InfoRow label="XHR / Fetch" value={`${metrics.resourceBreakdown.xhrSize.toFixed(1)} KB`} />
          </div>
        </div>
      )}

      {/* Lighthouse */}
      {lh && (
        <div>
          <div className="flex items-center gap-2 mb-3.5">
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Lighthouse Audit</span>
            <span className="text-[9px] font-mono text-tx-4 bg-bg border border-border px-1.5 rounded-chip">Google Lighthouse</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <ScoreGauge score={lh.performance}   label="Performance" />
            <ScoreGauge score={lh.accessibility} label="Accessibility" />
            <ScoreGauge score={lh.bestPractices} label="Best Practices" />
            <ScoreGauge score={lh.seo}           label="SEO" />
          </div>
          <p className="text-[10px] font-mono text-tx-4 mt-3.5 text-center">
            0–49 Poor · 50–89 Needs improvement · 90–100 Good
          </p>
        </div>
      )}
    </div>
  );
}
