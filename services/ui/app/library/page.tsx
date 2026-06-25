import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SCRIPT_TEMPLATES } from '@/lib/scriptTemplates';

export default function LibraryPage() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);

  const handleUse = (id: string) => {
    navigate(`/?useScriptTemplate=${id}`);
  };

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-start justify-between flex-wrap gap-3.5">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Templates</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Library</h1>
        </div>
      </div>

      <div className="px-4 md:px-9 py-6">
        <p className="text-[13px] text-tx-3 mb-5">
          Built-in k6 script templates — pick one to load into Custom Script mode and adapt to your target.
        </p>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
          {SCRIPT_TEMPLATES.map(t => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} className="bg-surface border border-border rounded-tile p-5 flex flex-col gap-3 hover:border-tx-5 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="w-8.5 h-8.5 rounded-control bg-bg border border-border flex items-center justify-center">
                    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="var(--tx-3)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 6 3 10l4 4M13 6l4 4-4 4" /></svg>
                  </div>
                  <span className="font-mono text-[11px] text-accent bg-orange-bg border border-orange-bd rounded-chip px-2 py-0.5">k6</span>
                </div>
                <div>
                  <div className="font-display text-[15px] font-semibold">{t.name}</div>
                  <div className="text-[12.5px] text-tx-3 leading-[1.5] mt-1">{t.description}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.tags.map(tag => (
                    <span key={tag} className="px-1.5 py-0.5 bg-bg border border-border rounded-chip text-[10px] font-mono text-tx-3">{tag}</span>
                  ))}
                </div>
                <div className="flex items-center justify-between mt-auto pt-1">
                  <button type="button" onClick={() => setExpanded(isOpen ? null : t.id)} className="text-[12px] text-tx-3 hover:text-tx">
                    {isOpen ? 'Hide preview' : 'Preview'}
                  </button>
                  <button type="button" onClick={() => handleUse(t.id)} className="text-accent text-[13px] font-bold">
                    Use template →
                  </button>
                </div>
                {isOpen && (
                  <pre className="border-t border-line bg-bg -mx-5 -mb-5 mt-1 p-4 text-[11px] font-mono overflow-x-auto max-h-80 overflow-y-auto rounded-b-tile">
                    <code>{t.script}</code>
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
