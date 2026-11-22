import type { SharedValue } from 'react-native-reanimated';

/** The edit a drawing contact started against, before JS or another hand can change it. */
export type DrawStrokeContext = {
  epoch: number;
  generation: number;
  enabled: boolean;
  tool: 'edit' | 'add' | 'trace' | 'refine' | 'join';
  targetId: number | null;
  brushPt: number;
  brushMode: 'add' | 'erase';
};

export type DrawStrokeSession = DrawStrokeContext & {
  id: number;
  zoom: number;
  isStylus: boolean;
};

/** Screen-owned values survive gesture remounts; ids never restart within an editor. */
export type DrawStrokeBinding = {
  contextSV: SharedValue<DrawStrokeContext>;
  sequenceSV: SharedValue<number>;
  previewIdSV: SharedValue<number>;
  activeIdSV: SharedValue<number>;
};

/** UI-thread compare-and-clear: an old JS completion cannot erase a newer contact. */
export function clearOwnedStroke(
  pointsSV: SharedValue<number[]>,
  previewIdSV: SharedValue<number>,
  strokeId: number,
): void {
  'worklet';
  if (previewIdSV.value !== strokeId) return;
  pointsSV.value = [];
  previewIdSV.value = 0;
}

export function strokeSessionIsCurrent(
  session: DrawStrokeSession | undefined,
  epoch: number,
  tool: DrawStrokeContext['tool'],
  generation: number,
): session is DrawStrokeSession {
  return (
    session !== undefined &&
    session.enabled &&
    session.epoch === epoch &&
    session.tool === tool &&
    session.generation === generation
  );
}

/** Release a cancelled/unmounted overlay only while it still owns the preview. */
export function releaseOwnedStroke(
  pointsSV: SharedValue<number[]>,
  previewIdSV: SharedValue<number>,
  activeIdSV: SharedValue<number>,
  strokeId: number,
): void {
  'worklet';
  if (previewIdSV.value !== strokeId) return;
  if (activeIdSV.value === strokeId) activeIdSV.value = 0;
  clearOwnedStroke(pointsSV, previewIdSV, strokeId);
}
