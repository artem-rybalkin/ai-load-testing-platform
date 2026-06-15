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
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-[15px] font-semibold text-[#24292f]">Script Library</h1>
        <p className="text-[12px] text-[#57606a] mt-1">
          Built-in k6 script templates — pick one to load into Custom Script mode and adapt to your target.
        </p>
      </div>

      <div className="space-y-3">
        {SCRIPT_TEMPLATES.map(t => {
          const isOpen = expanded === t.id;
          return (
            <div key={t.id} className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
              <div className="p-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-[13px] font-semibold text-[#24292f]">{t.name}</h2>
                  <p className="text-[12px] text-[#57606a] mt-1">{t.description}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {t.tags.map(tag => (
                      <span key={tag} className="px-1.5 py-0.5 bg-[#eaeef2] rounded text-[10px] font-mono text-[#57606a]">{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleUse(t.id)}
                    className="px-3 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[12px] font-medium transition-colors whitespace-nowrap"
                  >
                    Use this script
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : t.id)}
                    className="text-[11px] text-[#0969da] hover:underline whitespace-nowrap"
                  >
                    {isOpen ? 'Hide preview' : 'Preview'}
                  </button>
                </div>
              </div>
              {isOpen && (
                <pre className="border-t border-[#d0d7de] bg-[#f6f8fa] p-3 text-[11px] font-mono overflow-x-auto max-h-80 overflow-y-auto">
                  <code>{t.script}</code>
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
