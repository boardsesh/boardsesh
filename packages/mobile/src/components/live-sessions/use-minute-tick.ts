import { useEffect, useState } from 'react';
import { nowMs } from '../../lib/clock';

const MINUTE_MS = 60_000;

function currentMinute(): number {
  return Math.floor(nowMs() / MINUTE_MS);
}

/**
 * The current epoch minute, re-read on each minute boundary while `active`.
 * One tick for a whole rail keeps "42m" honest without a per-card timer or a
 * per-second render.
 */
export function useMinuteTick(active: boolean): number {
  const [minute, setMinute] = useState(currentMinute);

  useEffect(() => {
    if (!active) return;
    setMinute(currentMinute());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      // A few ms past the boundary so the floor lands on the new minute.
      const delay = MINUTE_MS - (nowMs() % MINUTE_MS) + 25;
      timer = setTimeout(() => {
        setMinute(currentMinute());
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  return minute;
}
