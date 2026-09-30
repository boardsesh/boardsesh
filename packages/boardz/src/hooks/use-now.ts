import { useEffect, useState } from 'react';

/** The current time, re-rendering every `intervalMs` while `active`. */
export function useNow(intervalMs: number, active = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
