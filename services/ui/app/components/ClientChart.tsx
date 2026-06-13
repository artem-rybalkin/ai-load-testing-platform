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
  'good':              'text-[#1a7f37] bg-[#dafbe1]',
  'needs-improvement': 'text-[#9a6700] bg-[#fff8c5]',
  'poor':              'text-[#cf222e] bg-[#ffebe9]',
};

const statusLabel = { 'good': 'Good', 'needs-improvement': 'Needs work', 'poor': 'Poor' };

const VitalCard = ({ label, value, unit, metricKey }: {
  label: string; value: number; unit: string; metricKey: string;
}) => {
  const status = getVitalStatus(metricKey, value);
  return (
    <div className="bg-[#f6f8fa] border border-[#d0d7de] rounded-md p-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide">{label}</p>
        <span className={`text-[10px] px-1.5 rounded font-mono font-medium ${statusCls[status]}`}>
          {statusLabel[status]}
        </span>
      </div>
      <p className="text-[20px] font-mono font-bold text-[#24292f] leading-none">
        {metricKey === 'cls' ? value.toFixed(3) : Math.round(value)}
        <span className="text-[11px] font-normal text-[#57606a] ml-1">{unit}</span>
      </p>
    </div>
  );
};

const InfoRow = ({ label, value }: { label: string; value: string | number }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-[#eaeef2] last:border-0">
    <span className="text-[11px] text-[#57606a]">{label}</span>
    <span className="text-[11px] font-mono font-medium text-[#24292f]">{value}</span>
  </div>
);

export const lhColor = (score: number) =>
  score >= 90 ? '#1f883d' : score >= 50 ? '#9a6700' : '#cf222e';

export const lhCls = (score: number) =>
  score >= 90 ? 'text-[#1a7f37] bg-[#dafbe1]' : score >= 50 ? 'text-[#9a6700] bg-[#fff8c5]' : 'text-[#cf222e] bg-[#ffebe9]';

const ScoreGauge = ({ score, label }: { score: number; label: string }) => {
  const color = lhColor(score);
  const c = 2 * Math.PI * 16;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-14 h-14">
        <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
          <circle cx="18" cy="18" r="16" fill="none" stroke="#eaeef2" strokeWidth="3" />
          <circle cx="18" cy="18" r="16" fill="none" stroke={color} strokeWidth="3"
            strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[13px] font-mono font-bold text-[#24292f]">
          {score}
        </span>
      </div>
      <span className="text-[10px] text-[#57606a] text-center leading-tight">{label}</span>
      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-medium ${lhCls(score)}`}>
        {score >= 90 ? 'Good' : score >= 50 ? 'Needs work' : 'Poor'}
      </span>
    </div>
  );
};

const TOOLTIP_STYLE = {
  background: '#fff',
  border: '1px solid #d0d7de',
  borderRadius: '6px',
  fontSize: 11,
  fontFamily: 'monospace',
  boxShadow: 'none',
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
    <div className="space-y-4">
      {/* Overall score */}
      <div className="flex items-center gap-4 p-3 bg-[#f6f8fa] border border-[#d0d7de] rounded-md">
        <div className="relative w-16 h-16 flex-shrink-0">
          <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
            <circle cx="18" cy="18" r="16" fill="none" stroke="#eaeef2" strokeWidth="3" />
            <circle cx="18" cy="18" r="16" fill="none"
              stroke={overallScore >= 70 ? '#1f883d' : overallScore >= 50 ? '#9a6700' : '#cf222e'}
              strokeWidth="3"
              strokeDasharray={`${overallScore} 100`}
              strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[15px] font-mono font-bold text-[#24292f]">
            {overallScore}
          </span>
        </div>
        <div>
          <p className="text-[13px] font-semibold text-[#24292f]">Web Vitals Score</p>
          <p className="text-[11px] text-[#57606a] mt-0.5">Based on Core Web Vitals thresholds</p>
          <p className="text-[11px] font-mono mt-1 text-[#57606a]">
            {overallScore >= 70 ? '● Good' : overallScore >= 50 ? '● Needs improvement' : '● Poor'}
          </p>
        </div>
      </div>

      {/* Radar */}
      <div>
        <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide block mb-2">Web Vitals Radar</span>
        <ResponsiveContainer width="100%" height={200}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="#eaeef2" />
            <PolarAngleAxis dataKey="metric" tick={{ fill: '#57606a', fontSize: 11, fontFamily: 'monospace' }} />
            <Radar dataKey="score" stroke="#0969da" fill="#0969da" fillOpacity={0.1} strokeWidth={1.5} />
            <Tooltip
              formatter={(v) => [`${Math.round(Number(v))}`, 'Score']}
              contentStyle={TOOLTIP_STYLE}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Core Web Vitals */}
      <div>
        <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide block mb-2">Core Web Vitals</span>
        <div className="grid grid-cols-2 gap-2">
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
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide block mb-2">Page Health</span>
          <div className="bg-[#f6f8fa] border border-[#d0d7de] rounded-md px-3 py-1">
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
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide block mb-2">
            Resource Breakdown
            <span className="ml-2 font-normal text-[#8c959f]">
              {metrics.resourceBreakdown.requestCount} requests · {metrics.resourceBreakdown.totalSize.toFixed(1)} KB total
            </span>
          </span>
          <div className="bg-[#f6f8fa] border border-[#d0d7de] rounded-md px-3 py-1">
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
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Lighthouse Audit</span>
            <span className="text-[9px] font-mono text-[#8c959f] bg-[#f6f8fa] border border-[#d0d7de] px-1.5 rounded">Google Lighthouse</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <ScoreGauge score={lh.performance}   label="Performance" />
            <ScoreGauge score={lh.accessibility} label="Accessibility" />
            <ScoreGauge score={lh.bestPractices} label="Best Practices" />
            <ScoreGauge score={lh.seo}           label="SEO" />
          </div>
          <p className="text-[10px] font-mono text-[#8c959f] mt-3 text-center">
            0–49 Poor · 50–89 Needs improvement · 90–100 Good
          </p>
        </div>
      )}
    </div>
  );
}
