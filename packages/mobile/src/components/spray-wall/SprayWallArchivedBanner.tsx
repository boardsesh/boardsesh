// The quiet notice an archived wall carries, on its board sheet and over its
// climb list (`docs/spray-walls.md`, "Archive and reset").
//
// An archived wall is read-only, not gone: its climbs, sends, queue and
// playlists all still work, so this says what stays and what does not, and
// offers the wall that replaced it when the viewer may see that one. It renders
// nothing for a live wall, a catalogue board, or a wall not registered yet, so a
// host can mount it unconditionally.

import { memo, useCallback } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { useSprayWallArchiveState } from '../../lib/spray/use-spray-wall-archive';
import { formatSprayArchiveDate } from '../../lib/spray/spray-archive-date';
import { useOpenSprayWall } from '../../lib/spray/use-open-spray-wall';
import { useSetActiveBoard } from '../../lib/graphql/use-active-board';

type SprayWallArchivedBannerProps = {
  boardName: string | null | undefined;
  layoutId: number | null;
  style?: StyleProp<ViewStyle>;
};

export const SprayWallArchivedBanner = memo(function SprayWallArchivedBanner({
  boardName,
  layoutId,
  style,
}: SprayWallArchivedBannerProps) {
  const archive = useSprayWallArchiveState(boardName, layoutId);
  // The live path stops here: one registry read, no switching machinery.
  if (!archive?.archivedAt) return null;
  return (
    <ArchivedNotice archivedAt={archive.archivedAt} replacedByWallUuid={archive.replacedByWallUuid} style={style} />
  );
});

/** The notice itself, mounted only for an archived wall. */
const ArchivedNotice = memo(function ArchivedNotice({
  archivedAt,
  replacedByWallUuid,
  style,
}: {
  archivedAt: string;
  replacedByWallUuid: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const setActiveBoard = useSetActiveBoard();
  const openSprayWall = useOpenSprayWall(setActiveBoard);
  const switchToReplacement = useCallback(() => {
    if (replacedByWallUuid) void openSprayWall(replacedByWallUuid);
  }, [openSprayWall, replacedByWallUuid]);

  const date = formatSprayArchiveDate(archivedAt, i18n.resolvedLanguage ?? i18n.language);
  const message = date ? t('sprayArchive.banner', { date }) : t('sprayArchive.bannerUndated');

  return (
    <View
      testID="spray-wall-archived-banner"
      style={[styles.surface, { backgroundColor: systemColors.secondaryBackground }, style]}
    >
      <View style={styles.row} accessible accessibilityLabel={message}>
        <Icon name="history" size={20} color={systemColors.secondaryLabel} />
        <Text variant="subheadline" color={systemColors.label} style={styles.text}>
          {message}
        </Text>
      </View>
      {replacedByWallUuid ? (
        <Button title={t('sprayArchive.switchToNew')} variant="text" onPress={switchToReplacement} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  surface: {
    gap: spacing[1],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  text: {
    flex: 1,
  },
});
