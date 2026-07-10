interface Props {
  height?: number;
  className?: string;
}

/** Lightweight placeholder shown while a lazy chunk loads, avoiding the
 *  blank-content flash a `null` Suspense fallback produces on first navigation. */
export default function Skeleton({ height = 160, className = '' }: Props) {
  return <div className={`w-full animate-pulse rounded-lg bg-hover ${className}`} style={{ height }} />;
}
