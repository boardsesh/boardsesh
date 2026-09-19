import { useEffect, useMemo, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getStoredActiveBoard } from '../lib/active-board-store';

/**
 * The board route params a climb-filter sub-route needs, recovered from the
 * active board when a screenshot deep link opened that route directly.
 *
 * `/climbs/holds`, `/climbs/zone` and `/climbs/setters` are pushed by
 * `ClimbFilterSheet`, which hands them the sheet's `boardConfig` as route params
 * (boardName / layoutId / sizeId / setIds, plus angle for setters). A capture
 * can't reach them that way: Maestro's accessibility tree on this iOS build
 * doesn't expose the sheet's pressables, so every screen is opened by deep link
 * (see `.maestro/help.yaml`), and a bare `com.boardsesh.app://climbs/holds`
 * carries no board at all. Without a fallback the hold/zone board renders empty
 * and the setter list keeps its query disabled — three blank screenshots.
 *
 * The board to fall back to is the one the rest of the capture is already
 * sitting on: `ScreenshotBoardAutoActivator` activates `SCREENSHOT_BOARDS[0]` on
 * boot, so the active board IS the shot wall. Deliberately not a board id baked
 * into the flow YAML — the capture account's boards drift, which is why
 * `SCREENSHOT_BOARDS` pins walls by NAME (see the long note in
 * `lib/screenshot-mode.ts`).
 *
 * Returns `null` in every normal build, and in screenshot mode whenever the
 * route already carried a board, so the real push path from the filter sheet is
 * untouched.
 *
 * Reads the active-board store directly rather than through `useActiveBoard()`,
 * for two reasons. It keeps the whole fallback inside an inlined
 * `process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1'` branch that babel-preset-expo
 * folds and terser drops (see the note at the top of `lib/screenshot-mode.ts`) —
 * a `useQuery` call has to sit outside the branch, so it would survive. And it
 * keeps these three screens renderable without a `QueryClientProvider`, which is
 * how their existing tests mount them.
 */
export type ScreenshotBoardParams = {
  boardName: string;
  layoutId: string;
  sizeId: string;
  setIds: string;
  angle: string;
};

export function useScreenshotBoardParams(routeBoardName: string | undefined): ScreenshotBoardParams | null {
  const [fallbackBoard, setFallbackBoard] = useState<UserBoard | null>(null);

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || routeBoardName) return;
    let cancelled = false;
    void getStoredActiveBoard().then((storedBoard) => {
      if (!cancelled) setFallbackBoard(storedBoard);
    });
    return () => {
      cancelled = true;
    };
  }, [routeBoardName]);

  return useMemo(() => {
    if (!fallbackBoard) return null;
    return {
      boardName: fallbackBoard.boardType,
      layoutId: String(fallbackBoard.layoutId),
      sizeId: String(fallbackBoard.sizeId),
      setIds: fallbackBoard.setIds,
      angle: String(fallbackBoard.angle),
    };
  }, [fallbackBoard]);
}
