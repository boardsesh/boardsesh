import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from '../../ClimbListThumbnail';
import { borderRadius } from '../../../theme/tokens';
import { useTranslation } from 'react-i18next';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { formatGrade } from '@boardsesh/play-view';
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
import { useTheme } from '../../../providers/theme-provider';

function stagedGrades(difficulty: string, boardName: string) {
  const grades = getBoulderGradesForBoard(boardName);
  const crowdIndex = grades.findIndex((grade) => grade.difficulty_name.toLowerCase() === difficulty.toLowerCase());
  const index = crowdIndex >= 0 ? crowdIndex : Math.min(8, grades.length - 2);
  // Keep a differing personal grade even for the hardest example in the catalogue.
  const personalIndex = index < grades.length - 1 ? index + 1 : index - 1;
  return { crowd: grades[index].difficulty_name, personal: grades[personalIndex].difficulty_name };
}
const PreviewGrade = memo(function PreviewGrade({ climb, boardName }: ClimbRowGradeLeafProps) {
  const { resolveGrade } = useDisplayGrade();
  const { personal } = stagedGrades(climb.difficulty, boardName);
  const grade = resolveGrade({ difficulty: personal }, boardName);
  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine
      isProject={false}
      setAtAngle={null}
      reserveSetAngleLine={false}
    />
  );
});
const PreviewSubtitle = memo(function PreviewSubtitle(props: ClimbRowSubtitleLeafProps) {
  const { gradeFormat } = useGradeFormat();
  const { crowd } = stagedGrades(props.difficulty, props.boardName);
  const crowdLabel = formatGrade(crowd, gradeFormat === 'both' ? 'v-grade' : gradeFormat, props.boardName);
  return (
    <ClimbSubtitleView
      {...props}
      qualityAverage={props.qualityAverage}
      communityGrade={props.showCommunityGrade ? crowdLabel : null}
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
  const { crowd } = stagedGrades(climb.difficulty, boardName);
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
  Favorite: ClimbFavoriteView,
  PlaylistChips: PreviewPlaylists,
};
export const CLIMB_ROW_PLAIN_PREVIEW_LEAVES: ClimbRowLeaves = {
  ...CLIMB_ROW_PREVIEW_LEAVES,
  Grade: PlainGrade,
  Subtitle: PlainSubtitle,
  AscentStatus: () => null,
  Favorite: () => null,
  PlaylistChips: () => null,
};

const styles = StyleSheet.create({
  neutralPicture: { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, borderRadius: borderRadius.sm },
});
