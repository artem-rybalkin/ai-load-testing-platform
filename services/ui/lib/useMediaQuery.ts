import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });

  useEffect(() => {
    let mql: MediaQueryList;
    try { mql = window.matchMedia(query); } catch { return; }
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
