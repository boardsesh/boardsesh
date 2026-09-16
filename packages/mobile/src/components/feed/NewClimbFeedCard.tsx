import { memo, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { ActivityFeedItem } from '@boardsesh/shared-schema';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../Card';
import { Text } from '../Text';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { spacing } from '../../theme/tokens';
const THUMBNAIL_SIZE = { width: 88, height: 110 };

export const NewClimbFeedCard = memo(function NewClimbFeedCard({ climb }: { climb: ActivityFeedItem }) {
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const { formatGrade } = useGradeFormat();
  const gradeLabel = formatGrade(climb.difficultyName ?? climb.gradeName ?? '');
  const details = [gradeLabel, climb.angle == null ? null : `${climb.angle}°`].filter(Boolean).join(' · ');
  const board = climb.boardType
    ? renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard)
    : null;
  const openClimb = useCallback(() => {
    if (!climb.climbUuid || !climb.boardType) return;
    openClimbInPlayDrawer(
      {
        kind: 'ref',
        climbUuid: climb.climbUuid,
        boardType: climb.boardType,
        layoutId: climb.renderBoard?.layoutId ?? climb.layoutId,
        angle: climb.angle ?? 0,
        sizeId: climb.renderBoard?.sizeId,
        setIds: climb.renderBoard?.setIds.join(','),
      },
      { openPlayDrawer, router },
      { preview: true },
    );
  }, [climb, openPlayDrawer, router]);
  const openSetter = useCallback(() => {
    if (climb.setterUsername)
      router.push({ pathname: '/(tabs)/climbs/setter/[username]', params: { username: climb.setterUsername } });
  }, [climb.setterUsername, router]);
  return (
    <Card style={styles.card}>
      <Text variant="footnote">
        {t('authors.newClimb')} · {formatRelativeTime(climb.createdAt)}
      </Text>
      <Pressable accessibilityRole="button" onPress={openClimb} style={styles.climb}>
        {board && climb.frames ? (
          <ClimbListThumbnail
            frames={climb.frames}
            boardName={board.boardName}
            layoutId={board.layoutId}
            sizeId={board.sizeId}
            setIds={board.setIds.join(',')}
            size={THUMBNAIL_SIZE}
          />
        ) : null}
        <View style={styles.details}>
          <Text variant="title3">{climb.climbName}</Text>
          <Text variant="body">{details}</Text>
          <Text variant="footnote">{formatBoardDisplayName(climb.boardType ?? '')}</Text>
        </View>
      </Pressable>
      {climb.setterUsername ? (
        <Pressable accessibilityRole="button" onPress={openSetter}>
          <Text variant="subheadline">{t('authors.setBy', { setter: climb.setterUsername })}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
});

const styles = StyleSheet.create({
  card: { marginBottom: spacing[3], gap: spacing[2] },
  climb: { flexDirection: 'row', gap: spacing[3], paddingVertical: spacing[2] },
  details: { flex: 1, gap: spacing[1] },
});
