import { memo } from 'react';
import { View } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { ClimbListItemContent, type ClimbListItemClimb } from './ClimbListItemContent';
import { climbListRowStyles } from './climb-list-row-styles';
import { useTheme } from '../providers/theme-provider';

type ClimbPreviewCardProps = {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/**
 * Static, non-interactive climb row shown at the top of the actions /
 * add-to-playlist sheets so it's obvious which climb the sheet acts on. Reuses
 * the climbs-list row visual (`ClimbListItemContent`) and layout
 * (`climbListRowStyles`) so it reads as a lifted copy of the list row — minus the
 * swipe actions, press gestures and selected-state overlay, which live in
 * `ClimbListRow`, not here. Painted with the same `systemColors.background` as
 * `ClimbListRow` itself (not left transparent): the sheet's `glass` material is
 * always opaque on iOS, but Android's sheet backing isn't guaranteed to be, so
 * the row needs its own opaque ground rather than relying on the sheet under it.
 * A hairline separator divides it from the action rows below.
 *
 * Memoized: its host sheets subscribe to route info (`ClimbActionsSheet` reaches
 * `useSegments` through `useCreateClimbNavigation`), so the sheet re-renders on every
 * navigation in the app. Props here are the climb plus primitives, so a shallow compare
 * keeps the board thumbnail out of that churn.
 */
function ClimbPreviewCardComponent({ climb, boardName, layoutId, sizeId, setIds, angle }: ClimbPreviewCardProps) {
  const { systemColors } = useTheme();
  return (
    <View style={{ backgroundColor: systemColors.background }}>
      <View style={climbListRowStyles.contentRow}>
        <ClimbListItemContent
          climb={climb}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
        />
      </View>
      <View style={[climbListRowStyles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
}

export const ClimbPreviewCard = memo(ClimbPreviewCardComponent);
