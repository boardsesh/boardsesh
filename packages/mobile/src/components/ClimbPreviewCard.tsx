import { memo } from 'react';
import { View } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { ClimbListItemContent, type ClimbListItemClimb } from './ClimbListItemContent';
import { climbListRowStyles } from './climb-list-row-styles';
import { useClimbRowField } from '../lib/climb-row-display-preference';
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
 * A hairline separator divides it from the action rows below, starting under
 * the text column like the list row's: at the gutter when thumbnails are off.
 *
 * Memoized: its host sheets re-render far more often than the climb changes (the
 * player's playlist host re-renders with the whole drawer). Props here are the climb
 * plus primitives, so a shallow compare keeps the board thumbnail out of that churn.
 */
function ClimbPreviewCardComponent({ climb, boardName, layoutId, sizeId, setIds, angle }: ClimbPreviewCardProps) {
  const { systemColors } = useTheme();
  const hasThumbnail = useClimbRowField('thumbnail');
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
      <View
        style={[
          climbListRowStyles.separator,
          hasThumbnail ? null : climbListRowStyles.separatorWithoutThumbnail,
          { backgroundColor: systemColors.separator },
        ]}
      />
    </View>
  );
}

export const ClimbPreviewCard = memo(ClimbPreviewCardComponent);
