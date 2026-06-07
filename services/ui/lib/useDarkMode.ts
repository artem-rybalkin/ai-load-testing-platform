import { useEffect, useState } from 'react';

const KEY = 'theme';

export function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) return stored === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch { return false; }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch { /* private browsing */ }
  }, [dark]);

  const toggle = () => setDark(d => !d);
  return { dark, toggle };
}
