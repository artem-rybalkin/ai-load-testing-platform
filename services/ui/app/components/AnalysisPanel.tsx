interface Diff {
  metric: string;
  current: number;
  previous: number;
  diffPercent: number;
  status: 'better' | 'same' | 'worse';
}

interface Analysis {
  perfStatus: string;
  diffs: Diff[];
  summary: string;
  thresholdViolations: string[];
}

const statusCfg = {
  passed:   { bg: 'bg-[#dafbe1]', text: 'text-[#1a7f37]', dot: 'bg-[#1f883d]', label: 'Passed'   },
  degraded: { bg: 'bg-[#fff8c5]', text: 'text-[#9a6700]',  dot: 'bg-[#9a6700]',  label: 'Degraded' },
  failed:   { bg: 'bg-[#ffebe9]', text: 'text-[#cf222e]',  dot: 'bg-[#cf222e]',  label: 'Failed'   },
};

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
    </div>
  );
}
