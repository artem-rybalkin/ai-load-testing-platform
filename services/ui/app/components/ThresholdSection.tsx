import type { Thresholds, HomeTestType } from '../home-types';
import type { ThresholdPreview } from '@/lib/api';
import type React from 'react';

interface Props {
  testType: HomeTestType;
  targetUrl: string;
  thresholds: Thresholds;
  setThresholds: React.Dispatch<React.SetStateAction<Thresholds>>;
  showThresholds: boolean;
  setShowThresholds: React.Dispatch<React.SetStateAction<boolean>>;
  suggestingThresholds: boolean;
  thresholdSuggestionNote: string | null;
  previewingThresholds: boolean;
  thresholdPreviewError: string | null;
  thresholdPreview: ThresholdPreview | null;
  handleSuggestThresholds: () => void;
  handlePreviewThresholds: () => void;
  inputCls: string;
}

export default function ThresholdSection({
  testType, targetUrl, thresholds, setThresholds,
  showThresholds, setShowThresholds,
  suggestingThresholds, thresholdSuggestionNote,
  previewingThresholds, thresholdPreviewError, thresholdPreview,
  handleSuggestThresholds, handlePreviewThresholds,
  inputCls,
}: Props) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setShowThresholds(v => !v)} className="flex items-center gap-1.5 text-[12.5px] text-tx-3 hover:text-tx py-0.5">
          <span className={`transition-transform inline-block text-[10px] ${showThresholds ? 'rotate-90' : ''}`}>▶</span>
          SLO thresholds
          {showThresholds && <span className="text-[11px] text-accent ml-1">active</span>}
        </button>
        {targetUrl && testType !== 'flow' && (
          <button type="button" onClick={handleSuggestThresholds} disabled={suggestingThresholds} className="text-[11px] text-accent hover:underline disabled:opacity-50 font-mono" title="Analyse run history and suggest realistic SLO values">
            {suggestingThresholds ? '⏳ Analysing…' : '✨ Suggest'}
          </button>
        )}
      </div>
      {thresholdSuggestionNote && <p className="text-[11px] text-tx-4 mt-1 font-mono">{thresholdSuggestionNote}</p>}
      {showThresholds && (
        <div className="mt-2.5 grid grid-cols-3 gap-2.5 p-4 bg-bg rounded-control border border-border">
          {(testType === 'client-side' ? [
            { key: 'lcp',  label: 'LCP ms'  }, { key: 'fcp',  label: 'FCP ms'  }, { key: 'ttfb', label: 'TTFB ms' },
            { key: 'cls',  label: 'CLS'     }, { key: 'inp',  label: 'INP ms'  }, { key: 'tbt',  label: 'TBT ms'  },
          ] : [
            { key: 'p95', label: 'p95 ms' }, { key: 'avg', label: 'Avg ms' }, { key: 'errorRate', label: 'Err %' },
            { key: 'serverErrorRate', label: '5xx err %' }, { key: 'timeoutRate', label: 'Timeout %' },
          ] as const).map(({ key, label }) => (
            <div key={key}>
              <div className="text-[10.5px] text-tx-4 mb-1">{label} max</div>
              <input type="number" min={0} value={(thresholds as unknown as Record<string, string>)[key]}
                onChange={e => setThresholds(t => ({ ...t, [key]: e.target.value }))} className={inputCls} />
            </div>
          ))}
        </div>
      )}
      {showThresholds && targetUrl && (
        <div className="mt-2">
          <button type="button" onClick={handlePreviewThresholds} disabled={previewingThresholds} className="text-[11px] text-accent hover:underline disabled:opacity-50 font-mono" title="Check these thresholds against the most recent completed run for this URL">
            {previewingThresholds ? '⏳ Checking…' : '👁 Preview against last run'}
          </button>
          {thresholdPreviewError && <p className="text-[11px] text-red-fg mt-1 font-mono">{thresholdPreviewError}</p>}
          {thresholdPreview && !thresholdPreview.available && <p className="text-[11px] text-tx-4 mt-1 font-mono">No completed run found for this URL yet.</p>}
          {thresholdPreview?.available && (
            <div className={`mt-1 p-2.5 rounded-control border text-[11px] font-mono ${
              thresholdPreview.perfStatus === 'failed' ? 'bg-red-bg border-red-fg/40 text-red-fg'
              : thresholdPreview.perfStatus === 'degraded' ? 'bg-amber-bg border-amber-fg/40 text-amber-fg'
              : 'bg-green-bg border-green-fg/40 text-green-fg'
            }`}>
              <p className="font-semibold">
                {thresholdPreview.perfStatus === 'failed' ? '✗ Would fail' : thresholdPreview.perfStatus === 'degraded' ? '⚠ Degraded' : '✓ Would pass'}
              </p>
              {thresholdPreview.thresholdViolations && thresholdPreview.thresholdViolations.length > 0 && (
                <ul className="list-disc list-inside mt-1">{thresholdPreview.thresholdViolations.map(v => <li key={v}>{v}</li>)}</ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
