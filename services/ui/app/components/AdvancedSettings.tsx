import type { HomeFormState, EnvVar } from '../home-types';
import { DURATION_OPTIONS } from '../home-types';
import type React from 'react';

interface Props {
  form: HomeFormState;
  setForm: React.Dispatch<React.SetStateAction<HomeFormState>>;
  showAdvanced: boolean;
  setShowAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  customHeaders: EnvVar[];
  setCustomHeaders: React.Dispatch<React.SetStateAction<EnvVar[]>>;
  inputCls: string;
}

export default function AdvancedSettings({ form, setForm, showAdvanced, setShowAdvanced, customHeaders, setCustomHeaders, inputCls }: Props) {
  return (
    <div>
      <button type="button" onClick={() => setShowAdvanced(v => !v)} className="flex items-center gap-1.5 text-[12.5px] text-tx-3 hover:text-tx py-0.5">
        <span className={`transition-transform inline-block text-[10px] ${showAdvanced ? 'rotate-90' : ''}`}>▶</span>
        Advanced settings
        {!showAdvanced && (
          <span className="text-[11px] text-tx-4 ml-1 font-mono">
            {form.type === 'client-side'
              ? `${form.sessions} sessions · ${form.duration}`
              : `${form.vus} VUs · ${form.duration}${form.rampUp ? ` · ramp ${form.rampUp}` : ''}${form.type === 'backend' ? ` · ${form.profile}` : ''}`}
          </span>
        )}
      </button>
      {showAdvanced && (
        <div className="mt-2.5 space-y-3.5 p-4 bg-bg rounded-control border border-border">
          {form.type === 'backend' && (
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Profile</div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { id: 'load',     label: 'Load',     hint: 'Constant VUs' },
                  { id: 'spike',    label: 'Spike',    hint: 'Traffic burst' },
                  { id: 'capacity', label: 'Capacity', hint: 'Find breakpoint' },
                  { id: 'soak',     label: 'Soak',     hint: 'Long steady-state' },
                ] as const).map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, profile: p.id }))}
                    className={`py-2 px-3 rounded-control border text-left transition-colors ${
                      form.profile === p.id ? 'border-ink-bd bg-surface' : 'border-border bg-surface hover:bg-hover'
                    }`}
                  >
                    <div className="text-[12.5px] font-semibold">{p.label}</div>
                    <div className="text-[10.5px] text-tx-4">{p.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {form.type === 'client-side' ? (
              <div>
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Browser sessions</div>
                <input type="number" min={1} max={10} value={form.sessions}
                  onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))} className={inputCls} />
              </div>
            ) : (
              <div>
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                  {form.profile === 'spike' || form.profile === 'capacity' ? 'Baseline VUs' : 'Users'}
                </div>
                <input type="number" min={1} max={100} value={form.vus}
                  onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))} className={inputCls} />
              </div>
            )}
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Duration</div>
              <select value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} className={inputCls}>
                {DURATION_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          {form.type !== 'client-side' && (
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Ramp-up <span className="normal-case font-normal text-tx-4">(optional, e.g. 30s, 1m)</span></div>
              <input type="text" placeholder="30s" value={form.rampUp} onChange={e => setForm(f => ({ ...f, rampUp: e.target.value }))} className={inputCls} />
            </div>
          )}
          {form.type === 'backend' && (form.profile === 'spike' || form.profile === 'capacity') && (
            <div>
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                {form.profile === 'spike' ? 'Peak VUs (spike target)' : 'Max VUs (capacity ceiling)'}
              </div>
              <input type="number" min={form.vus + 1} max={500} value={form.peakVus}
                onChange={e => setForm(f => ({ ...f, peakVus: Number(e.target.value) }))} className={inputCls} />
            </div>
          )}

          {form.type !== 'client-side' && (
            <div className="pt-3 border-t border-line">
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-2">HTTP Settings</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-[12.5px] text-tx cursor-pointer">
                  <input type="checkbox" checked={form.httpKeepAlive} onChange={e => setForm(f => ({ ...f, httpKeepAlive: e.target.checked }))} className="rounded-sm border-border" />
                  Keep-alive connections
                </label>
                <label className="flex items-center gap-2 text-[12.5px] text-tx cursor-pointer">
                  <input type="checkbox" checked={form.httpDiscardBodies} onChange={e => setForm(f => ({ ...f, httpDiscardBodies: e.target.checked }))} className="rounded-sm border-border" />
                  Discard response bodies <span className="text-tx-4">(faster, saves memory)</span>
                </label>
                <div>
                  <div className="text-[11px] text-tx-3 mb-1">Request timeout <span className="text-tx-4">(e.g. 30s, 1m)</span></div>
                  <input type="text" placeholder="30s" value={form.httpTimeout} onChange={e => setForm(f => ({ ...f, httpTimeout: e.target.value }))} className={inputCls} />
                </div>
              </div>
            </div>
          )}

          {form.type !== 'flow' && (
            <div className="pt-3 border-t border-line">
              <div className="flex items-center justify-between mb-1.5">
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Custom Headers</div>
                <button type="button" onClick={() => setCustomHeaders(h => [...h, { key: '', value: '' }])} className="text-[11px] text-accent hover:underline">+ add</button>
              </div>
              {customHeaders.map((h, i) => (
                <div key={i} className="flex gap-1.5 mb-1.5 items-center">
                  <input type="text" placeholder="Header-Name" value={h.key}
                    onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                    className="w-40 border border-border rounded-control px-2.5 py-1 text-[11px] font-mono bg-surface focus:outline-none" />
                  <span className="text-tx-4 text-[11px]">:</span>
                  <input type="text" placeholder="value" value={h.value}
                    onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                    className="flex-1 border border-border rounded-control px-2.5 py-1 text-[11px] font-mono bg-surface focus:outline-none" />
                  <button type="button" onClick={() => setCustomHeaders(hs => hs.filter((_, j) => j !== i))} className="text-tx-4 hover:text-red-fg text-[11px]">✕</button>
                </div>
              ))}
              {customHeaders.length === 0 && <p className="text-[11px] text-tx-4">No custom headers. Sent with every request (e.g. API keys, auth tokens).</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
