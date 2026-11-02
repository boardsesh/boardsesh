import { useCallback, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { hapticSelection } from '../../lib/haptics';
import type { SectionMoveDirection } from '../../lib/section-layout';
import {
  announceSectionMoved,
  placeSectionLayoutRows,
  type PlacedSectionLayoutRow,
  type SectionLayoutRowModel,
} from './SectionLayoutList';
import { SectionLayoutFormList } from './SectionLayoutFormList';
import type { MovableFormRows } from './section-layout-form-rows';

// A first guess at one row's height at the default text size, until the list
// reports what it really drew. Scaled by the text size so the guess is close.
const ROW_HEIGHT_GUESS = 68;

type MovableFormRowsInput<Id extends string> = {
  /** The rows that move, in the climber's order. */
  rows: readonly SectionLayoutRowModel<Id>[];
  disabled?: boolean;
  onVisibleChange: (rowId: Id, visible: boolean) => void;
  /** Returns `false` when it refuses the move, so nothing buzzes or is said. */
  onMove: (rowId: Id, direction: SectionMoveDirection) => boolean;
  /** The hosted list's test id, which also names its layout report in tests. */
  testID: string;
};

/**
 * The rows that move on a Settings page, drawn the platform's way (see
 * `section-layout-form-rows.ts`): Android gets native switches with native
 * move buttons, iOS and the browser one hosted `SectionLayoutFormList`, sized
 * from what it draws so Dynamic Type grows it. A native move buzzes and says
 * where the row landed, as the hosted arrows do.
 */
export function useMovableFormRows<Id extends string>({
  rows,
  disabled,
  onVisibleChange,
  onMove,
  testID,
}: MovableFormRowsInput<Id>): MovableFormRows<Id> {
  const { t } = useTranslation('common');
  const { fontScale } = useWindowDimensions();
  // A drawn height holds for the row count it was drawn at: a page whose rows come
  // and go (a quick filter switched off leaves the list) guesses again until the
  // list reports its new height.
  const rowCount = rows.length;
  const [measured, setMeasured] = useState<{ rowCount: number; height: number } | null>(null);
  const listHeight =
    measured?.rowCount === rowCount ? measured.height : Math.ceil(rowCount * ROW_HEIGHT_GUESS * Math.max(fontScale, 1));
  const onHeightChange = useCallback((height: number) => setMeasured({ rowCount, height }), [rowCount]);
  // Android's Compose form draws no hosted React Native row on a real phone (QA
  // on a Pixel 8 Pro, #6546).
  const nativeRows = Platform.OS === 'android';
  const onNativeMove = useCallback(
    (row: PlacedSectionLayoutRow<Id>, direction: SectionMoveDirection) => {
      if (disabled || !onMove(row.id, direction)) return;
      hapticSelection();
      announceSectionMoved(t, row, direction);
    },
    [disabled, onMove, t],
  );
  return useMemo<MovableFormRows<Id>>(
    () =>
      nativeRows
        ? { kind: 'native', rows: placeSectionLayoutRows(rows), onMove: onNativeMove }
        : {
            kind: 'hosted',
            content: (
              <SectionLayoutFormList
                rows={rows}
                disabled={disabled}
                onVisibleChange={onVisibleChange}
                onMove={onMove}
                onHeightChange={onHeightChange}
                testID={testID}
              />
            ),
            height: listHeight,
          },
    [nativeRows, rows, onNativeMove, disabled, onVisibleChange, onMove, onHeightChange, testID, listHeight],
  );
}
