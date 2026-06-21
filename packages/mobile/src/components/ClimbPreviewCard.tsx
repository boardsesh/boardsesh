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
 * `ClimbListRow`, not here. The row sits transparent on the sheet's glass so it
 * stays cohesive with the action rows below; a hairline separator divides it from
 * them.
 */
export function ClimbPreviewCard({ climb, boardName, layoutId, sizeId, setIds, angle }: ClimbPreviewCardProps) {
  const { systemColors } = useTheme();
  return (
    <View>
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
