'use client';

import { useState } from 'react';

interface Diff {
  metric: string;
  current: number;
  previous: number;
  diffPercent: number;
  status: 'better' | 'same' | 'worse';
}

interface AiInsights {
  narrative: string;
  anomalies: string[];
  rootCauses: string[];
  recommendations: string[];
  severity: 'critical' | 'warning' | 'info';
}

interface Analysis {
  perfStatus: string;
  diffs: Diff[];
  summary: string;
  thresholdViolations: string[];
  aiInsights?: AiInsights;
}

const statusCfg = {
  passed:   { bg: 'bg-[#dafbe1]', text: 'text-[#1a7f37]', dot: 'bg-[#1f883d]', label: 'Passed'   },
  degraded: { bg: 'bg-[#fff8c5]', text: 'text-[#9a6700]',  dot: 'bg-[#9a6700]',  label: 'Degraded' },
  failed:   { bg: 'bg-[#ffebe9]', text: 'text-[#cf222e]',  dot: 'bg-[#cf222e]',  label: 'Failed'   },
};

const severityIcon = { critical: '🔴', warning: '🟡', info: '🟢' };

const DiffRow = ({ diff }: { diff: Diff }) => {
  const arrow = diff.diffPercent > 0 ? '↑' : diff.diffPercent < 0 ? '↓' : '→';
  const cls   = diff.status === 'better' ? 'text-[#1f883d]' : diff.status === 'worse' ? 'text-[#cf222e]' : 'text-[#8c959f]';
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[#eaeef2] last:border-0">
      <span className="text-[12px] text-[#57606a]">{diff.metric}</span>
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="text-[#8c959f]">{diff.previous}</span>
        <span className="text-[#d0d7de]">→</span>
        <span className="font-semibold text-[#24292f]">{diff.current}</span>
        <span className={`w-14 text-right font-semibold ${cls}`}>
          {arrow} {Math.abs(diff.diffPercent)}%
        </span>
      </div>
    </div>
  );
};

const InsightList = ({ items, color }: { items: string[]; color: string }) => (
  <ul className="space-y-1">
    {items.map((item, i) => (
      <li key={i} className={`text-[11px] flex gap-1.5 ${color}`}>
        <span className="flex-shrink-0 mt-0.5">•</span>
        <span>{item}</span>
      </li>
    ))}
  </ul>
);

const AiInsightsPanel = ({ insights }: { insights: AiInsights }) => {
  const [expanded, setExpanded] = useState(false);
  const icon = severityIcon[insights.severity] ?? '🟢';

  return (
    <div className="border border-[#d0d7de] rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#f6f8fa] hover:bg-[#eaeef2] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px]">{icon}</span>
          <span className="text-[12px] font-semibold text-[#24292f]">AI Insights</span>
          <span className="text-[11px] text-[#57606a] hidden sm:block">{insights.narrative.slice(0, 60)}{insights.narrative.length > 60 ? '…' : ''}</span>
        </div>
        <span className="text-[#57606a] text-[11px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-3 py-2.5 space-y-3 bg-white border-t border-[#eaeef2]">
          {/* Narrative */}
          <p className="text-[12px] text-[#24292f] leading-relaxed">{insights.narrative}</p>

          {/* Anomalies */}
          {insights.anomalies.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1">Anomalies detected</p>
              <InsightList items={insights.anomalies} color="text-[#cf222e]" />
            </div>
          )}

          {/* Root Causes */}
          {insights.rootCauses.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1">Likely root causes</p>
              <InsightList items={insights.rootCauses} color="text-[#9a6700]" />
            </div>
          )}

          {/* Recommendations */}
          {insights.recommendations.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1">Recommendations</p>
              <InsightList items={insights.recommendations} color="text-[#0969da]" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  const cfg = statusCfg[analysis.perfStatus as keyof typeof statusCfg] ?? statusCfg.passed;

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-md ${cfg.bg}`}>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
        <span className={`text-[13px] font-semibold ${cfg.text}`}>{cfg.label}</span>
        <span className={`text-[12px] ${cfg.text} opacity-80`}>{analysis.summary}</span>
      </div>

      {/* Threshold violations */}
      {analysis.thresholdViolations.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Threshold violations:</p>
          {analysis.thresholdViolations.map((v, i) => (
            <div key={i} className="text-[11px] font-mono text-[#cf222e] flex items-center gap-1.5 mb-1">
              <span>⚠</span> {v}
            </div>
          ))}
        </div>
      )}

      {/* Diffs */}
      {analysis.diffs.length > 0 ? (
        <div>
          <p className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Compared to previous run:</p>
          <div className="bg-[#f6f8fa] border border-[#d0d7de] rounded-md px-3 py-1">
            {analysis.diffs.map((diff, i) => (
              <DiffRow key={i} diff={diff} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] font-mono text-[#8c959f]">No previous run found for comparison</p>
      )}

      {/* AI Insights */}
      {analysis.aiInsights && (
        <AiInsightsPanel insights={analysis.aiInsights} />
      )}
    </div>
  );
}
