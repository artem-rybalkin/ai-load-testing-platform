import { Link, useLocation } from 'react-router-dom';

const NAV = [
  { href: '/',          icon: '⊕', label: 'New'       },
  { href: '/results',   icon: '≡', label: 'Results'   },
  { href: '/schedules', icon: '⏱', label: 'Schedules' },
  { href: '/presets', icon: '◫', label: 'Presets' },
  { href: '/webhooks',  icon: '◻', label: 'Webhooks'  },
];

export default function BottomNav() {
  const { pathname } = useLocation();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 md:hidden bg-white border-t border-[#d0d7de] flex">
      {NAV.map(({ href, icon, label }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            to={href}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
              active ? 'text-[#0969da]' : 'text-[#57606a] hover:text-[#24292f]'
            }`}
          >
            <span className="text-[18px] leading-none">{icon}</span>
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
