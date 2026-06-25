import { useDarkMode } from '@/lib/useDarkMode';

interface TopBarProps {
  onMenuClick: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { dark, toggle: toggleDark } = useDarkMode();

  return (
    <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-sidebar-bg border-b border-sidebar-border">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} className="flex text-sidebar-bright cursor-pointer">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h14M4 11h14M4 15h14" /></svg>
        </button>
        <span className="font-display text-[14px] font-bold text-white tracking-[-0.01em] whitespace-nowrap">ARTEM RYBALKIN<span className="text-accent">.</span></span>
      </div>
      <button
        onClick={toggleDark}
        className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] border border-sidebar-border text-sidebar-bright text-[12.5px]"
      >
        {dark
          ? <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5Z" strokeLinejoin="round" /></svg>
          : <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10" cy="10" r="3.4" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.5 1.5M15.4 4.6 14 6M6 14l-1.4 1.5" strokeLinecap="round" /></svg>}
      </button>
    </header>
  );
}
