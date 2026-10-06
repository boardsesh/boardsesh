// The screenful a photo step fits its photo into: the corner step and the crop
// step (issue #5958, and the photo step's "Crop or rotate").
//
// The copy takes the height it needs, the photo gets everything left over (the
// measured `stage`), and the marker fits the photo inside that. Below
// `MIN_STAGE_HEIGHT` the photo stops shrinking and the page scrolls instead —
// and it never scrolls while a handle is held, so a drag can never become a
// scroll. `SprayCornerStep` has the long version of why.

import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { spacing } from '../../theme/tokens';
import { CORNER_HANDLE_SIZE } from './corner-photo-fit';

/** Widest the photo is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PHOTO_WIDTH = 520;

/** The shortest the photo's slot is ever made, however little room the screen leaves. */
export const MIN_STAGE_HEIGHT = 200 + CORNER_HANDLE_SIZE;

/** Layout jitter smaller than this is not worth re-fitting the photo for. */
export const LAYOUT_EPSILON = 0.5;

type Size = { width: number; height: number };
const NO_SIZE: Size = { width: 0, height: 0 };

export type FittedPhotoStage = {
  /** For the stage view's `onLayout`. */
  onStageLayout: (event: LayoutChangeEvent) => void;
  /** Spread onto the step's ScrollView. */
  scrollProps: {
    scrollEnabled: boolean;
    onLayout: (event: LayoutChangeEvent) => void;
    onContentSizeChange: (width: number, height: number) => void;
  };
  /** Hand to the marker: a finger landed on a handle (true) or left it (false). */
  onDragActiveChange: (active: boolean) => void;
  /** The box the marker fits the photo inside, floored at zero before the stage is measured. */
  maxPhotoWidth: number;
  maxPhotoHeight: number;
};

export function useFittedPhotoStage(): FittedPhotoStage {
  const [stage, setStage] = useState<Size>(NO_SIZE);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const onStageLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage((previous) =>
      Math.abs(previous.width - width) < LAYOUT_EPSILON && Math.abs(previous.height - height) < LAYOUT_EPSILON
        ? previous
        : { width, height },
    );
  }, []);
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportHeight(event.nativeEvent.layout.height);
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    setContentHeight(height);
  }, []);

  // Scrolls only when the content really is taller than the screen — that is,
  // only when the stage has hit its floor.
  const overflows = contentHeight > viewportHeight + LAYOUT_EPSILON;

  // And never while a handle is held. Counted, because two handles can be held
  // at once and the page must stay put until the last finger lifts. The marker
  // reports a finger landing and leaving, so this is two state changes per drag.
  const heldHandles = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragActiveChange = useCallback((active: boolean) => {
    heldHandles.current = Math.max(0, heldHandles.current + (active ? 1 : -1));
    setDragging(heldHandles.current > 0);
  }, []);

  // The stage runs edge to edge so the handle layer, which overhangs the photo
  // by half a handle on every side, has room. For a photo limited by its width
  // the layer is still 12 points wider than the stage (the gutter is 16, the
  // overhang 22), so 6 points of each outer touch target fall outside it, off
  // the edge of the screen. The handles themselves are whole.
  // Floored at zero: before the stage is measured these would be negative, and
  // "no room yet" should not depend on every reader treating that as zero.
  const maxPhotoWidth = Math.max(0, Math.min(MAX_PHOTO_WIDTH, stage.width - spacing[4] * 2));
  const maxPhotoHeight = Math.max(0, stage.height - CORNER_HANDLE_SIZE);

  return {
    onStageLayout,
    scrollProps: { scrollEnabled: overflows && !dragging, onLayout: onViewportLayout, onContentSizeChange },
    onDragActiveChange,
    maxPhotoWidth,
    maxPhotoHeight,
  };
}
