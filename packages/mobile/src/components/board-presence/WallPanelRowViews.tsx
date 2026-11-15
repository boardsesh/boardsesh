import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardDriverAvatar } from './BoardDriverAvatar';
import { wallDriverForClimb } from '../../lib/board-presence/presence-climb';
import type { HeroContentProps, HistoryRowContentProps } from './NowOnTheWallPanel';
import { styles } from './wall-panel-styles';
export function WallHeroContentView({
  climb,
  thumbnail,
  labelColor,
  secondaryColor,
  accentColor,
  formattedGrade,
  gradeColor,
  isActionLoading = false,
  pressableAvatar = true,
}: HeroContentProps & { thumbnail: ReactNode }) {
  const { t } = useTranslation('session');
  const litBy = climb.sentByDisplayName?.trim() || null;
  const setter = climb.setter?.trim();

  return (
    <>
      {thumbnail}
      <View style={styles.heroBody}>
        <View style={styles.heroNameRow}>
          <Text
            testID={`board-current-${climb.climbUuid}-${climb.sentByUserId ?? 'anonymous'}`}
            variant="headline"
            color={labelColor}
            numberOfLines={1}
            style={styles.heroName}
          >
            {climb.name ?? ''}
          </Text>
          {formattedGrade ? (
            <Text variant="headline" style={[styles.heroGrade, { color: gradeColor }]}>
              {formattedGrade}
            </Text>
          ) : null}
          {isActionLoading ? (
            <ActivityIndicator
              size="small"
              accessibilityLabel={t('mobile.boardPresence.actionLoading')}
              style={styles.actionSpinner}
            />
          ) : null}
        </View>
        {setter ? (
          <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
            {t('mobile.boardPresence.setByLine', { setter })}
          </Text>
        ) : null}
        {litBy ? (
          <View style={styles.heroDriverRow}>
            <BoardDriverAvatar
              size={20}
              userId={pressableAvatar ? climb.sentByUserId : null}
              uri={climb.sentByAvatarUrl}
              name={litBy}
              status="connected"
              accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: litBy })}
            />
            <Text variant="caption1" color={accentColor} numberOfLines={1} style={styles.heroDriverName}>
              {litBy}
            </Text>
          </View>
        ) : null}
      </View>
    </>
  );
}

export function WallHistoryContentView({
  climb,
  thumbnail,
  labelColor,
  secondaryColor,
  formattedGrade,
  gradeColor,
  isActionLoading = false,
  pressableAvatar = true,
  sentAgo,
}: HistoryRowContentProps & { thumbnail: ReactNode; sentAgo: string }) {
  const { t } = useTranslation('session');
  const driver = wallDriverForClimb(climb, t('mobile.boardPresence.unnamedClimber'));
  const isKilterImport = climb.source === 'kilter';
  // Kilter imports only arrive while someone has the app open, so the history
  // has gaps; the time on each row is what makes them readable (#6012). It
  // rides on the first caption line (the Kilter source line, else the sender
  // row) and gets a line of its own only when the row has neither. Computed
  // at render: the rows are memoized, so it can lag while the sheet stays open.
  const sourceLine = isKilterImport
    ? [t('mobile.boardPresence.kilterHistorySource'), sentAgo].filter(Boolean).join(' · ')
    : driver
      ? ''
      : sentAgo;
  const senderTime = !isKilterImport && driver ? sentAgo : '';

  return (
    <>
      {thumbnail}
      <View style={styles.historyBody}>
        <Text
          testID={`board-history-${climb.climbUuid}-${climb.seq}`}
          variant="subheadline"
          color={labelColor}
          numberOfLines={1}
          style={styles.historyName}
        >
          {climb.name ?? ''}
        </Text>
        {sourceLine ? (
          <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
            {sourceLine}
          </Text>
        ) : null}
        {driver ? (
          <View style={styles.historyDriverRow}>
            {/* Past send — no Bluetooth glyph (nobody's driving it now); just a
                pressable face for attribution. */}
            <BoardDriverAvatar
              size={18}
              userId={pressableAvatar ? climb.sentByUserId : null}
              uri={climb.sentByAvatarUrl}
              name={driver.avatarName}
              status="none"
              accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: driver.label })}
            />
            <Text variant="caption1" color={secondaryColor} numberOfLines={1} style={styles.historyDriverName}>
              {driver.label}
            </Text>
            {/* Its own Text so a long name truncates before the time does. */}
            {senderTime ? (
              <Text variant="caption1" color={secondaryColor} numberOfLines={1} style={styles.historySentAgo}>
                {`· ${senderTime}`}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {formattedGrade ? (
        <Text variant="headline" style={[styles.historyGrade, { color: gradeColor }]}>
          {formattedGrade}
        </Text>
      ) : null}
      {isActionLoading ? (
        <ActivityIndicator
          size="small"
          accessibilityLabel={t('mobile.boardPresence.actionLoading')}
          style={styles.actionSpinner}
        />
      ) : null}
    </>
  );
}
