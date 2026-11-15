import {
  createContext,
  useContext,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

export const SHOWCASE_ANCHOR_NAMES = [
  'board-surface',
  'invite-qr',
  'queue-row-avatar',
  'play-next',
  'profile-board-filter',
  'board-history-button',
  'now-on-wall',
  'wall-history',
  'workout-type',
  'rest-timer',
  'activity-calendar',
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

export type LayoutObservation = { name: ShowcaseAnchorName; x: number; y: number; width: number; height: number };
const LayoutObserverContext = createContext<((observation: LayoutObservation) => void) | null>(null);
export function LayoutObserverProvider({
  onLayoutObserved,
  children,
}: {
  onLayoutObserved: (observation: LayoutObservation) => void;
  children: ReactNode;
}) {
  return createElement(LayoutObserverContext, { value: onLayoutObserved }, children);
}
export function useLayoutObserverEnabled(): boolean {
  return useContext(LayoutObserverContext) !== null;
}

export function useShowcaseAnchor(name: ShowcaseAnchorName, enabled = true): ShowcaseAnchorProps {
  const observer = useContext(LayoutObserverContext);
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
      if (!observer || !enabled) return;
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
          observer({ name, x: roundPoint(x), y: roundPoint(y), width: roundPoint(width), height: roundPoint(height) });
        });
      };
      measure();
      clearTimers(timersRef.current);
      for (const delay of SHOWCASE_ANCHOR_SETTLE_DELAYS_MS) timersRef.current.push(setTimeout(measure, delay));
    },
    [name, observer, enabled],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => clearTimers(timers);
  }, []);

  const props = useMemo<ShowcaseAnchorProps>(() => ({ ref, onLayout }), [ref, onLayout]);
  return enabled && observer ? props : NO_ANCHOR;
}

type ShowcaseAnchorViewProps = { name: ShowcaseAnchorName; enabled?: boolean; testID?: string; children: ReactNode };

export function ShowcaseAnchorView({ name, enabled = true, testID, children }: ShowcaseAnchorViewProps) {
  const anchor = useShowcaseAnchor(name, enabled);
  if (!anchor.onLayout) return children;
  // `collapsable: false` keeps Android from flattening the wrapper away, which
  // would leave nothing to measure.
  return createElement(View, { ...anchor, testID, collapsable: false }, children);
}
