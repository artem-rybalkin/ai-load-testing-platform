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
  passed:   { bg: 'bg-green-bg', text: 'text-green-fg-2', dot: 'bg-status-pass', label: 'Passed'   },
  degraded: { bg: 'bg-amber-bg', text: 'text-amber-badge-fg', dot: 'bg-status-slow', label: 'Degraded' },
  failed:   { bg: 'bg-red-bg',   text: 'text-red-badge-fg', dot: 'bg-status-fail', label: 'Failed'   },
};

const severityIcon = { critical: '🔴', warning: '🟡', info: '🟢' };

const DiffRow = ({ diff }: { diff: Diff }) => {
  const arrow = diff.diffPercent > 0 ? '↑' : diff.diffPercent < 0 ? '↓' : '→';
  const cls   = diff.status === 'better' ? 'text-green-fg' : diff.status === 'worse' ? 'text-red-fg' : 'text-tx-4';
  return (
    <div className="flex items-center justify-between py-2 border-b border-line last:border-0">
      <span className="text-[12px] text-tx-3">{diff.metric}</span>
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="text-tx-4">{diff.previous}</span>
        <span className="text-border">→</span>
        <span className="font-semibold">{diff.current}</span>
        <span className={`w-14 text-right font-semibold ${cls}`}>
          {arrow} {Math.abs(diff.diffPercent)}%
        </span>
      </div>
    </div>
  );
};

const InsightList = ({ items, color }: { items: string[]; color: string }) => (
  <ul className="space-y-1.5">
    {items.map((item, i) => (
      <li key={i} className={`text-[11.5px] flex gap-1.5 ${color}`}>
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
    <div className="border border-border rounded-control overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-bg hover:bg-hover transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px]">{icon}</span>
          <span className="text-[12.5px] font-semibold">AI Insights</span>
          <span className="text-[11px] text-tx-3 hidden sm:block">{insights.narrative.slice(0, 60)}{insights.narrative.length > 60 ? '…' : ''}</span>
        </div>
        <span className="text-tx-3 text-[11px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-3.5 py-3 space-y-3.5 bg-surface border-t border-border">
          {/* Narrative */}
          <p className="text-[12.5px] leading-relaxed">{insights.narrative}</p>

          {/* Anomalies */}
          {insights.anomalies.length > 0 && (
            <div>
              <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Anomalies detected</p>
              <InsightList items={insights.anomalies} color="text-red-fg" />
            </div>
          )}

          {/* Root Causes */}
          {insights.rootCauses.length > 0 && (
            <div>
              <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Likely root causes</p>
              <InsightList items={insights.rootCauses} color="text-amber-badge-fg" />
            </div>
          )}

          {/* Recommendations */}
          {insights.recommendations.length > 0 && (
            <div>
              <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Recommendations</p>
              <InsightList items={insights.recommendations} color="text-accent" />
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
    <div className="space-y-3.5">
      {/* Status */}
      <div className={`flex items-center gap-2 px-3.5 py-2.5 rounded-control ${cfg.bg}`}>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
        <span className={`text-[13px] font-semibold ${cfg.text}`}>{cfg.label}</span>
        <span className={`text-[12px] ${cfg.text} opacity-80`}>{analysis.summary}</span>
      </div>

      {/* Threshold violations */}
      {analysis.thresholdViolations.length > 0 && (
        <div>
          <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase mb-2">Threshold violations:</p>
          {analysis.thresholdViolations.map((v, i) => (
            <div key={i} className="text-[11.5px] font-mono text-red-fg flex items-center gap-1.5 mb-1">
              <span>⚠</span> {v}
            </div>
          ))}
        </div>
      )}

      {/* Diffs */}
      {analysis.diffs.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] tracking-[0.06em] text-tx-4 uppercase mb-2">Compared to previous run:</p>
          <div className="bg-bg border border-border rounded-control px-3.5 py-1">
            {analysis.diffs.map((diff, i) => (
              <DiffRow key={i} diff={diff} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11.5px] font-mono text-tx-4">No previous run found for comparison</p>
      )}

      {/* AI Insights */}
      {analysis.aiInsights && (
        <AiInsightsPanel insights={analysis.aiInsights} />
      )}
    </div>
  );
}
