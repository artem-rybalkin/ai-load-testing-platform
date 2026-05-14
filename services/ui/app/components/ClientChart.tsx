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

interface ClientMetrics {
  lcp: number;
  fcp: number;
  ttfb: number;
  fid: number;
  cls: number;
  lighthouseScore?: LighthouseScore;
}

// ─── Web Vitals helpers ───────────────────────────────────────────────────────

const vitalThresholds = {
  lcp:  { good: 2500, poor: 4000 },
  fcp:  { good: 1800, poor: 3000 },
  ttfb: { good: 800,  poor: 1800 },
  fid:  { good: 100,  poor: 300 },
};

const getVitalStatus = (key: string, value: number): 'good' | 'needs-improvement' | 'poor' => {
  const t = vitalThresholds[key as keyof typeof vitalThresholds];
  if (!t) return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
};

const statusColor = {
  'good':             'text-green-600 bg-green-50',
  'needs-improvement':'text-yellow-600 bg-yellow-50',
  'poor':             'text-red-600 bg-red-50',
};

const statusLabel = { 'good': 'Good', 'needs-improvement': 'Needs work', 'poor': 'Poor' };

const VitalCard = ({ label, value, unit, metricKey }: {
  label: string; value: number; unit: string; metricKey: string;
}) => {
  const status = getVitalStatus(metricKey, value);
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-gray-500">{label}</p>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[status]}`}>
          {statusLabel[status]}
        </span>
      </div>
      <p className="text-2xl font-bold text-gray-900">
        {metricKey === 'cls' ? value.toFixed(3) : Math.round(value)}
        <span className="text-sm font-normal text-gray-500 ml-1">{unit}</span>
      </p>
    </div>
  );
};

// ─── Lighthouse helpers ───────────────────────────────────────────────────────

const lhColor = (score: number) =>
  score >= 90 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';

const lhBadge = (score: number) =>
  score >= 90
    ? 'text-green-700 bg-green-50'
    : score >= 50
    ? 'text-yellow-700 bg-yellow-50'
    : 'text-red-700 bg-red-50';

const lhLabel = (score: number) =>
  score >= 90 ? 'Good' : score >= 50 ? 'Needs work' : 'Poor';

const ScoreGauge = ({ score, label }: { score: number; label: string }) => {
  const color = lhColor(score);
  const circumference = 2 * Math.PI * 16; // r=16
  const dash = (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-14 h-14">
        <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
          <circle cx="18" cy="18" r="16" fill="none" stroke="#f0f0f0" strokeWidth="3" />
          <circle
            cx="18" cy="18" r="16" fill="none"
            stroke={color} strokeWidth="3"
            strokeDasharray={`${dash} ${circumference}`}
            strokeLinecap="round"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-gray-900">
          {score}
        </span>
      </div>
      <span className="text-xs text-gray-500 text-center leading-tight">{label}</span>
      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${lhBadge(score)}`}>
        {lhLabel(score)}
      </span>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function ClientChart({ metrics }: { metrics: ClientMetrics }) {
  const radarData = [
    { metric: 'LCP',  score: Math.max(0, 100 - (metrics.lcp  / 4000) * 100) },
    { metric: 'FCP',  score: Math.max(0, 100 - (metrics.fcp  / 3000) * 100) },
    { metric: 'TTFB', score: Math.max(0, 100 - (metrics.ttfb / 1800) * 100) },
    { metric: 'FID',  score: Math.max(0, 100 - (metrics.fid  / 300)  * 100) },
    { metric: 'CLS',  score: Math.max(0, 100 - (metrics.cls  / 0.25) * 100) },
  ];

  const overallScore = Math.round(radarData.reduce((s, d) => s + d.score, 0) / radarData.length);
  const lh = metrics.lighthouseScore;

  return (
    <div className="space-y-6">

      {/* Overall Web Vitals score */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-6">
        <div className="relative w-20 h-20 flex-shrink-0">
          <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90">
            <circle cx="18" cy="18" r="16" fill="none" stroke="#f0f0f0" strokeWidth="3" />
            <circle
              cx="18" cy="18" r="16" fill="none"
              stroke={overallScore >= 70 ? '#22c55e' : overallScore >= 50 ? '#f59e0b' : '#ef4444'}
              strokeWidth="3"
              strokeDasharray={`${overallScore} 100`}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-gray-900">
            {overallScore}
          </span>
        </div>
        <div>
          <h3 className="font-medium text-gray-900">Web Vitals score</h3>
          <p className="text-sm text-gray-500 mt-0.5">Based on Core Web Vitals</p>
          <p className="text-xs text-gray-400 mt-1">
            {overallScore >= 70 ? '✅ Good performance' : overallScore >= 50 ? '⚠️ Needs improvement' : '❌ Poor performance'}
          </p>
        </div>
      </div>

      {/* Radar chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-medium text-gray-700 mb-4">Web Vitals radar</h3>
        <ResponsiveContainer width="100%" height={220}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="#f0f0f0" />
            <PolarAngleAxis dataKey="metric" tick={{ fontSize: 12 }} />
            <Radar
              dataKey="score"
              stroke="#3b82f6"
              fill="#3b82f6"
              fillOpacity={0.15}
              strokeWidth={2}
            />
            <Tooltip formatter={(v) => [`${Math.round(Number(v))}`, 'Score']} />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Individual Web Vitals */}
      <div className="grid grid-cols-2 gap-3">
        <VitalCard label="Largest Contentful Paint" value={metrics.lcp}  unit="ms" metricKey="lcp" />
        <VitalCard label="First Contentful Paint"   value={metrics.fcp}  unit="ms" metricKey="fcp" />
        <VitalCard label="Time to First Byte"        value={metrics.ttfb} unit="ms" metricKey="ttfb" />
        <VitalCard label="First Input Delay"         value={metrics.fid}  unit="ms" metricKey="fid" />
        <VitalCard label="Cumulative Layout Shift"   value={metrics.cls}  unit=""   metricKey="cls" />
      </div>

      {/* Lighthouse scores */}
      {lh && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-5">
            <h3 className="text-sm font-medium text-gray-700">Lighthouse audit</h3>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              powered by Google Lighthouse
            </span>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <ScoreGauge score={lh.performance}   label="Performance" />
            <ScoreGauge score={lh.accessibility} label="Accessibility" />
            <ScoreGauge score={lh.bestPractices} label="Best Practices" />
            <ScoreGauge score={lh.seo}           label="SEO" />
          </div>

          <p className="text-xs text-gray-400 mt-4 text-center">
            Scores 0–49 Poor · 50–89 Needs improvement · 90–100 Good
          </p>
        </div>
      )}

    </div>
  );
}
