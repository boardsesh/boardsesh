import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from '../../ClimbListThumbnail';
import { borderRadius } from '../../../theme/tokens';
import { useTranslation } from 'react-i18next';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { deriveClimbRowGrade } from '../../../lib/climb-row-grade';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import {
  ClimbAscentStatusView,
  ClimbFavoriteView,
  ClimbGradeView,
  ClimbSubtitleView,
  type ClimbRowLeaves,
  type ClimbRowThumbnailLeafProps,
  type ClimbRowGradeLeafProps,
  type ClimbRowSubtitleLeafProps,
  type ClimbRowAscentStatusLeafProps,
} from '../../ClimbListItemContent';
import { ClimbPlaylistChipsView, type ClimbRowPlaylistChipsLeafProps } from '../../ClimbPlaylistChips';
import { ClimbProgressView, type ClimbRowProgressLeafProps } from '../../ClimbProgressLine';
import { useTheme } from '../../../providers/theme-provider';

export function stagedGrades(difficulty: string, boardName: string, gradeFormat: GradeDisplayFormat) {
  const grades = getBoulderGradesForBoard(boardName);
  const crowdIndex = grades.findIndex((grade) => grade.difficulty_name.toLowerCase() === difficulty.toLowerCase());
  const index = crowdIndex >= 0 ? crowdIndex : Math.min(8, grades.length - 2);
  const crowd = grades[index].difficulty_name;
  const communityLabel = formatGrade(crowd, gradeFormat, boardName);
  // Several mapping entries read as one V grade. Find the next displayed grade,
  // then search downwards when the crowd is already at the top of the scale.
  const candidates = [...grades.slice(index + 1), ...grades.slice(0, index).reverse()];
  const personal =
    candidates.find((grade) => {
      // Show the next V band, including when a Font-plus entry would add only
      // a plus suffix to the same V number in the column.
      if (gradeFormat !== 'font' && grade.v_grade === grades[index].v_grade) return false;
      return (
        deriveClimbRowGrade({
          personalLabel: formatGrade(grade.difficulty_name, gradeFormat, boardName),
          communityLabel,
        }).communityGradeToken !== null
      );
    })?.difficulty_name ?? crowd;
  return {
    crowd,
    personal,
    ...deriveClimbRowGrade({
      personalLabel: formatGrade(personal, gradeFormat, boardName),
      communityLabel,
    }),
  };
}
const PreviewGrade = memo(function PreviewGrade({ climb, boardName }: ClimbRowGradeLeafProps) {
  const { resolveGrade } = useDisplayGrade();
  const { gradeFormat } = useGradeFormat();
  const { personal, markedAsMine } = stagedGrades(climb.difficulty, boardName, gradeFormat);
  const grade = resolveGrade({ difficulty: personal }, boardName);
  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine={markedAsMine}
      isProject={false}
      setAtAngle={null}
      reserveSetAngleLine={false}
    />
  );
});
const PreviewSubtitle = memo(function PreviewSubtitle(props: ClimbRowSubtitleLeafProps) {
  const { gradeFormat } = useGradeFormat();
  const { communityGradeToken } = stagedGrades(props.difficulty, props.boardName, gradeFormat);
  return (
    <ClimbSubtitleView
      {...props}
      qualityAverage={props.qualityAverage}
      communityGrade={props.showCommunityGrade ? communityGradeToken : null}
    />
  );
});
const PreviewStatus = memo(function PreviewStatus({ supportsMirroring, reserveLine }: ClimbRowAscentStatusLeafProps) {
  return (
    <ClimbAscentStatusView
      supportsMirroring={supportsMirroring}
      ascentStatus="flash"
      mirrorStatus="send"
      reserveLine={reserveLine}
    />
  );
});
const PreviewProgress = memo(function PreviewProgress({
  supportsMirroring,
  showDirectionStatuses,
  reserveLine,
}: ClimbRowProgressLeafProps) {
  return (
    <ClimbProgressView
      supportsMirroring={supportsMirroring}
      showDirectionStatuses={showDirectionStatuses}
      reserveLine={reserveLine}
      progress={{
        status: 'flash',
        outcome: { kind: 'flash', sendCount: 3 },
        mirror: 'both',
        originalStatus: 'flash',
        mirrorStatus: 'attempt',
        latestClimbedAtMs: null,
      }}
    />
  );
});
const PreviewPlaylists = memo(function PreviewPlaylists({ reserveLine }: ClimbRowPlaylistChipsLeafProps) {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const chips = useMemo(
    () => [
      {
        key: 'projects',
        name: t('mobile.settings.climbList.samplePlaylistOne'),
        dotColor: brandColors.primary,
        emoji: null,
      },
      {
        key: 'warmup',
        name: t('mobile.settings.climbList.samplePlaylistTwo'),
        dotColor: brandColors.primary,
        emoji: null,
      },
    ],
    [t, brandColors.primary],
  );
  return <ClimbPlaylistChipsView chips={chips} reserveLine={reserveLine} />;
});
const PreviewThumbnail = memo(function PreviewThumbnail(props: ClimbRowThumbnailLeafProps) {
  const { systemColors } = useTheme();
  if (props.layoutId === 0)
    return (
      <View
        testID="climb-preview-neutral-picture"
        style={[styles.neutralPicture, { backgroundColor: systemColors.fill }]}
      />
    );
  return <ClimbListThumbnail {...props} />;
});
const PlainGrade = memo(function PlainGrade({ climb, boardName }: ClimbRowGradeLeafProps) {
  const { resolveGrade } = useDisplayGrade();
  const { gradeFormat } = useGradeFormat();
  const { crowd } = stagedGrades(climb.difficulty, boardName, gradeFormat);
  const grade = resolveGrade({ difficulty: crowd }, boardName);
  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine={false}
      isProject={false}
      setAtAngle={null}
      reserveSetAngleLine={false}
    />
  );
});
const PlainSubtitle = memo(function PlainSubtitle(props: ClimbRowSubtitleLeafProps) {
  return <ClimbSubtitleView {...props} communityGrade={null} />;
});
/** Staged personal marks: no auth, logbook, memberships or favorite reads. */
export const CLIMB_ROW_PREVIEW_LEAVES: ClimbRowLeaves = {
  Thumbnail: PreviewThumbnail,
  Grade: PreviewGrade,
  Subtitle: PreviewSubtitle,
  AscentStatus: PreviewStatus,
  Progress: PreviewProgress,
  Favorite: ClimbFavoriteView,
  PlaylistChips: PreviewPlaylists,
};
export const CLIMB_ROW_PLAIN_PREVIEW_LEAVES: ClimbRowLeaves = {
  ...CLIMB_ROW_PREVIEW_LEAVES,
  Grade: PlainGrade,
  Subtitle: PlainSubtitle,
  AscentStatus: () => null,
  Progress: ({ reserveLine }) => (
    <ClimbProgressView
      supportsMirroring={false}
      showDirectionStatuses={false}
      reserveLine={reserveLine}
      progress={null}
    />
  ),
  Favorite: () => null,
  PlaylistChips: () => null,
};

const styles = StyleSheet.create({
  neutralPicture: { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, borderRadius: borderRadius.sm },
});
