// Which look a board surface draws with, without rendering anything. Split out
// of use-native-climb-render.ts for the same reason as
// boardsesh-renderer-support.ts: that module's other imports pull `expo-asset`
// into every test that touches it, and a section that only needs to match the
// board's hold markers should not drag the native render graph in with it.
import type { BoardRenderMode } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  boardLookForRender,
  resolveEffectiveRenderSettings,
  useBoardRenderSettings,
  type BoardRenderSettings,
} from '../lib/board-render-settings';
import { sprayBoardRenderDefault, subscribeToSprayWalls } from '../lib/spray/spray-wall-registry';
import { useSprayWallsUseOwnLook } from '../lib/spray-wall-look-preference';
import {
  getBoardseshRendererSupport,
  getBoardseshSupportRevision,
  subscribeToBoardseshSupport,
} from './boardsesh-renderer-support';

/**
 * The board's own stored look a surface draws with — a spray wall's, `null` for
 * every catalogue board. It wins over the climber's own look unless they chose
 * their own on spray walls, or the surface brings its own drawing.
 *
 * Its own subscription rather than a ride on the wall's version token: that
 * token only moves with the wall's VERSION, and a look stored without a reset
 * would never reach a surface mounted before it. The registry keeps an
 * unchanged look's identity across re-registrations, so a revalidation costs
 * no re-resolve.
 */
export function useBoardRenderDefault(
  boardName: BoardName,
  layoutId: number,
  surface: { hasSettingsOverride: boolean; hasMarkStyleOverride: boolean },
): BoardRenderSettings | null {
  const storedBoardLook = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => sprayBoardRenderDefault(boardName, layoutId), [boardName, layoutId]),
  );
  const useOwnLookOnSprayWalls = useSprayWallsUseOwnLook();
  return boardLookForRender({
    storedLook: storedBoardLook,
    useOwnLook: useOwnLookOnSprayWalls,
    hasSettingsOverride: surface.hasSettingsOverride,
    hasMarkStyleOverride: surface.hasMarkStyleOverride,
  });
}

/**
 * Which drawing a plain board surface for this board uses: the climber's look,
 * a spray wall's own look and the installed renderer's support, resolved the
 * way the board resolves them. `roleGlyphs` is true when the Aura drawing marks
 * each role with its accessibility glyph; classic draws marker shapes instead.
 *
 * It only reads the renderer's support. The board on the same screen kicks the
 * capability probe, and the answer reaches this through the same subscription.
 * For UI that must match the board's holds, such as the Active holds section.
 */
export function useBoardRenderMode(
  boardName: BoardName,
  layoutId: number,
): { mode: BoardRenderMode; roleGlyphs: boolean } {
  const { settings } = useBoardRenderSettings();
  const boardDefault = useBoardRenderDefault(boardName, layoutId, {
    hasSettingsOverride: false,
    hasMarkStyleOverride: false,
  });
  const supportRevision = useSyncExternalStore(
    subscribeToBoardseshSupport,
    getBoardseshSupportRevision,
    getBoardseshSupportRevision,
  );
  const { mode, roleGlyphs } = useMemo(() => {
    void supportRevision;
    const effective = resolveEffectiveRenderSettings(settings, getBoardseshRendererSupport() === true, boardDefault);
    return { mode: effective.mode, roleGlyphs: effective.mode === 'aura' && effective.boardsesh.roleGlyphs };
  }, [settings, boardDefault, supportRevision]);
  return useMemo(() => ({ mode, roleGlyphs }), [mode, roleGlyphs]);
}
