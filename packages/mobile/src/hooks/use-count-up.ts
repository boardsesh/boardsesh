import { useEffect, useRef, useState } from 'react';

/**
 * A bounded, one-shot count-up from 0 → `target` on mount (and whenever `target`
 * changes). Returns the current integer to render. This is deliberately a short
 * mount tween driven by requestAnimationFrame — NOT a per-frame ongoing
 * animation — so it stays clear of the RN performance checklist's "no per-frame
 * state churn" rule (it settles in ~250ms and stops). When `enabled` is false
 * (Reduce Motion), it snaps to `target` immediately and never schedules a frame.
 *
 * Keep it on small, glanceable numerals (streak weeks, benchmarks, sends, active
 * days, tries) — not on a value that updates continuously.
 */
export function useCountUp(target: number, enabled: boolean, durationMs = 250): number {
  const [display, setDisplay] = useState(enabled ? 0 : target);
  // Track the latest target without retriggering the effect's identity.
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || durationMs <= 0) {
      setDisplay(target);
      return;
    }
    const from = 0;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const progress = Math.min(1, (ts - startTs) / durationMs);
      // easeOutCubic — fast then settles, reads as a confident landing.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, enabled, durationMs]);

  return display;
}
