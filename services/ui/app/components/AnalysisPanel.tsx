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

const statusConfig = {
  passed:   { color: 'bg-green-50 border-green-200',  text: 'text-green-700',  badge: 'bg-green-100 text-green-700',  icon: '✅', label: 'Passed' },
  degraded: { color: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700', icon: '⚠️', label: 'Degraded' },
  failed:   { color: 'bg-red-50 border-red-200',      text: 'text-red-700',    badge: 'bg-red-100 text-red-700',      icon: '❌', label: 'Failed' },
};

const DiffRow = ({ diff }: { diff: Diff }) => {
  const arrow = diff.diffPercent > 0 ? '↑' : diff.diffPercent < 0 ? '↓' : '→';
  const color = diff.status === 'better' ? 'text-green-600' : diff.status === 'worse' ? 'text-red-600' : 'text-gray-400';

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{diff.metric}</span>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">{diff.previous}</span>
        <span className="text-xs text-gray-300">→</span>
        <span className="text-sm font-medium text-gray-900">{diff.current}</span>
        <span className={`text-xs font-medium ${color} w-16 text-right`}>
          {arrow} {Math.abs(diff.diffPercent)}%
        </span>
      </div>
    </div>
  );
};

export default function AnalysisPanel({ analysis }: { analysis: Analysis }) {
  const cfg = statusConfig[analysis.perfStatus as keyof typeof statusConfig] || statusConfig.passed;

  return (
    <div className={`rounded-xl border p-5 ${cfg.color}`}>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xl">{cfg.icon}</span>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-900">Performance Analysis</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cfg.badge}`}>
              {cfg.label}
            </span>
          </div>
          <p className={`text-sm mt-0.5 ${cfg.text}`}>{analysis.summary}</p>
        </div>
      </div>

      {/* Threshold violations */}
      {analysis.thresholdViolations.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-medium text-gray-700 mb-1.5">Threshold violations:</p>
          {analysis.thresholdViolations.map((v, i) => (
            <div key={i} className="text-xs text-red-600 flex items-center gap-1.5 mb-1">
              <span>⚠</span> {v}
            </div>
          ))}
        </div>
      )}

      {/* Comparison with previous */}
      {analysis.diffs.length > 0 && (
        <div className="bg-white rounded-lg p-3 mt-2">
          <p className="text-xs font-medium text-gray-500 mb-2">Compared to previous run:</p>
          {analysis.diffs.map((diff, i) => (
            <DiffRow key={i} diff={diff} />
          ))}
        </div>
      )}

      {analysis.diffs.length === 0 && (
        <p className="text-xs text-gray-500 mt-1">No previous run found for comparison</p>
      )}
    </div>
  );
}