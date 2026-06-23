import { Link, useLocation } from 'react-router-dom';

const LABELS: Record<string, string> = {
  '/':           'New Test',
  '/results':    'Results',
  '/schedules':  'Schedules',
  '/presets':  'Presets',
  '/webhooks':   'Webhooks',
};

export default function TopBar() {
  const { pathname } = useLocation();

  // derive a label: exact match first, then starts-with for dynamic routes
  const label =
    LABELS[pathname] ??
    Object.entries(LABELS).find(([k]) => k !== '/' && pathname.startsWith(k))?.[1] ??
    'AI Load Testing';

  return (
    <header className="md:hidden sticky top-0 z-40 bg-white border-b border-[#d0d7de] flex items-center justify-between h-10 px-3">
      <span className="text-[13px] font-semibold text-[#24292f]">⚡ {label}</span>
      <Link
        to="/"
        className="text-[12px] font-medium text-[#0969da] hover:underline"
      >
        + New
      </Link>
    </header>
  );
}
