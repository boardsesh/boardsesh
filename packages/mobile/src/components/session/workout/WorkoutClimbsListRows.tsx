import type { ComponentProps } from 'react';
import { renderBoardToPlaylistConfig } from '../../../lib/playlists/board-details-for-playlist';
import { ClimbListThumbnail } from '../../ClimbListThumbnail';
import { WorkoutSetRowView } from './WorkoutClimbsListRowsView';
export { WorkoutBlockSectionRow, WorkoutListSectionLabel, WorkoutPlannedClimbRow } from './WorkoutClimbsListRowsView';
export function WorkoutSetRow(props: Omit<ComponentProps<typeof WorkoutSetRowView>, 'thumbnail'>) {
  const { climb } = props;
  const config =
    climb.frames && climb.boardType
      ? renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard)
      : null;
  return (
    <WorkoutSetRowView
      {...props}
      thumbnail={
        config && climb.frames ? (
          <ClimbListThumbnail
            climbUuid={climb.climbUuid}
            frames={climb.frames}
            boardName={config.boardName}
            layoutId={config.layoutId}
            sizeId={config.sizeId}
            setIds={config.setIds.join(',')}
            mirrored={climb.isMirror ?? false}
            size={{ width: 44, height: 56 }}
          />
        ) : undefined
      }
    />
  );
}
