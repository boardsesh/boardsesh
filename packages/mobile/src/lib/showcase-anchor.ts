// Screenshot mode ONLY: tells the homepage showcase-video recorder where each
// callout target sits on screen, so a callout follows the UI instead of a
// hand-measured box.
//
// The contract lives in `scripts/lib/showcase-video/contract.ts`. The app can't
// import from `scripts/`, so the names and the log prefix are copied here, and
// `__tests__/showcase-anchor.test.ts` reads that file as text and fails when the
// two drift apart.
//
// Outside screenshot mode `useShowcaseAnchor` is a function that returns one
// frozen object: no hooks, no state, no re-render, nothing per list row. The
// choice between the two implementations is made once, at module load, on the
// inlined `process.env.EXPO_PUBLIC_SCREENSHOT_MODE` comparison, so a normal
// build folds it and drops the screenshot implementation (see
// `./screenshot-mode.ts`).

import { createElement, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

export const SHOWCASE_ANCHOR_NAMES = [
  'wall-pill',
  'board-surface',
  'invite-qr',
  'queue-row-avatar',
  'play-next',
  'profile-board-filter',
] as const;
export type ShowcaseAnchorName = (typeof SHOWCASE_ANCHOR_NAMES)[number];

export const SHOWCASE_ANCHOR_LOG_PREFIX = '[showcase-anchor]';

/**
 * Re-measure this long after a layout, because a sheet that slides or springs
 * in moves its content with a transform, which fires no second layout. The last
 * delay covers the slowest sheet spring in the app.
 */
export const SHOWCASE_ANCHOR_SETTLE_DELAYS_MS = [250, 700] as const;

type MeasureInWindowCallback = (x: number, y: number, width: number, height: number) => void;
type Measurable = { measureInWindow: (callback: MeasureInWindowCallback) => void };

export type ShowcaseAnchorProps = Readonly<{
  ref: ((instance: Measurable | null) => void) | undefined;
  onLayout: ((event: LayoutChangeEvent) => void) | undefined;
}>;

const NO_ANCHOR: ShowcaseAnchorProps = Object.freeze({ ref: undefined, onLayout: undefined });

/** The exact line the recorder parses, or null for a rect that isn't on screen yet. */
export function formatShowcaseAnchorLine(
  name: ShowcaseAnchorName,
  x: number,
  y: number,
  width: number,
  height: number,
): string | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const rect = { name, x: roundPoint(x), y: roundPoint(y), width: roundPoint(width), height: roundPoint(height) };
  return `${SHOWCASE_ANCHOR_LOG_PREFIX} ${JSON.stringify(rect)}`;
}

function roundPoint(value: number): number {
  return Math.round(value * 10) / 10;
}

function asMeasurable(target: unknown): Measurable | null {
  if (typeof target !== 'object' || target === null) return null;
  return typeof (target as Partial<Measurable>).measureInWindow === 'function' ? (target as Measurable) : null;
}

function clearTimers(timers: ReturnType<typeof setTimeout>[]): void {
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
}

function useScreenshotShowcaseAnchor(name: ShowcaseAnchorName, enabled = true): ShowcaseAnchorProps {
  const instanceRef = useRef<Measurable | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastLineRef = useRef<string | null>(null);

  const ref = useCallback((instance: Measurable | null) => {
    instanceRef.current = instance;
    // A view that unmounts and comes back at the same rect (a sheet closed and
    // reopened) must log again, or the recorder never learns it reappeared.
    if (instance === null) lastLineRef.current = null;
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      // The ref is the reliable handle; the event's own target covers a
      // component that takes onLayout but no ref. Read it now: React clears
      // `currentTarget` once dispatch ends.
      const target = instanceRef.current ?? asMeasurable(event.currentTarget);
      if (!target) return;
      const measure = () => {
        target.measureInWindow((x, y, width, height) => {
          const line = formatShowcaseAnchorLine(name, x, y, width, height);
          if (line === null || line === lastLineRef.current) return;
          lastLineRef.current = line;
          console.log(line);
        });
      };
      measure();
      clearTimers(timersRef.current);
      for (const delay of SHOWCASE_ANCHOR_SETTLE_DELAYS_MS) timersRef.current.push(setTimeout(measure, delay));
    },
    [name],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => clearTimers(timers);
  }, []);

  const props = useMemo<ShowcaseAnchorProps>(() => ({ ref, onLayout }), [ref, onLayout]);
  return enabled ? props : NO_ANCHOR;
}

function useNoShowcaseAnchor(_name: ShowcaseAnchorName, _enabled?: boolean): ShowcaseAnchorProps {
  return NO_ANCHOR;
}

/**
 * Spread onto the view a callout should point at: `<View {...anchor}>`. Pass
 * `enabled: false` for every list row but the one to report, so a list never
 * logs more than one rect under a name.
 */
export const useShowcaseAnchor: (name: ShowcaseAnchorName, enabled?: boolean) => ShowcaseAnchorProps =
  process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? useScreenshotShowcaseAnchor : useNoShowcaseAnchor;

type ShowcaseAnchorViewProps = { name: ShowcaseAnchorName; enabled?: boolean; children: ReactNode };

function ScreenshotShowcaseAnchorView({ name, enabled = true, children }: ShowcaseAnchorViewProps) {
  const anchor = useScreenshotShowcaseAnchor(name, enabled);
  if (!anchor.onLayout) return children;
  // `collapsable: false` keeps Android from flattening the wrapper away, which
  // would leave nothing to measure.
  return createElement(View, { ...anchor, collapsable: false }, children);
}

function PassThroughShowcaseAnchorView({ children }: ShowcaseAnchorViewProps) {
  return children;
}

/**
 * For a target that takes no ref (a shared row or button component): wraps it
 * in a measured View in screenshot mode, and renders it untouched otherwise.
 */
export const ShowcaseAnchorView: (props: ShowcaseAnchorViewProps) => ReactNode =
  process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? ScreenshotShowcaseAnchorView : PassThroughShowcaseAnchorView;
