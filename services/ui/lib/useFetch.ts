import { useState, useEffect, useCallback, useRef } from 'react';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useFetch<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList = []
): FetchState<T> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const execute = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: null }));
    fnRef.current()
      .then(data => setState({ data, loading: false, error: null }))
      .catch(err => setState(s => ({ ...s, loading: false, error: String(err) })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  return { ...state, refetch: execute };
}
