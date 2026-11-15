import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { sanitizeBoardRenderSettings } from '../../lib/board-render-settings';
import { DEFAULT_HOLD_BRUSH_THICKNESS, DEFAULT_HOLD_SHAPE_SIZE } from '../../lib/hold-color-overrides';
import type { BoardRenderStyle } from '../../lib/board-render-style';
import { getBoardseshRendererSupport, subscribeToBoardseshSupport } from '../../hooks/boardsesh-renderer-support';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';

export type StoryRenderMode = 'aura' | 'classic' | 'default';
export function parseStoryRenderMode(mode: string): StoryRenderMode {
  if (mode === 'aura' || mode === 'classic' || mode === 'default') return mode;
  throw new Error(`Unsupported story renderer: ${mode}`);
}
function createStyle(mode: StoryRenderMode): BoardRenderStyle {
  return {
    gridLabels: true,
    settings: sanitizeBoardRenderSettings({ mode }),
    holds: {
      overrides: {},
      shapes: {},
      brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
      shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
    },
  };
}
const styles = { aura: createStyle('aura'), classic: createStyle('classic'), default: createStyle('default') };
export const StoryRenderModeContext = createContext<StoryRenderMode>('aura');
export function useStoryBoardRenderStyle(): BoardRenderStyle {
  return styles[useContext(StoryRenderModeContext)];
}
/** Never acknowledge a capture that silently fell back to another renderer. */
export function useStoryRendererReady(): boolean {
  const mode = useContext(StoryRenderModeContext);
  const support = useSyncExternalStore(
    subscribeToBoardseshSupport,
    getBoardseshRendererSupport,
    getBoardseshRendererSupport,
  );
  useEffect(() => {
    if (mode !== 'classic') ensureBoardseshSupportProbed();
  });
  if (mode !== 'classic' && support === false) throw new Error('Requested Aura renderer is unavailable in this binary');
  return mode === 'classic' || support === true;
}
