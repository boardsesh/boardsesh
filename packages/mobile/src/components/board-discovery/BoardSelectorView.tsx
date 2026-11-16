import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

/**
 * The board picker's body (#5654 and the 2026-11 redesign), top to bottom:
 * the top (At {gym}, the board heard somewhere else, or what the scan needs;
 * see picker-top-view.ts), Your boards (or the empty state), Near you. First
 * run swaps Your boards and Near you for "Where do you climb?" under the top.
 * The ways to add a board live in the screen's top bar.
 *
 * Presentational: the screen hands in each section ready-made.
 */
export function BoardSelectorView({
  scrollBottomPadding,
  activeSprayName,
  onActiveBoardDetails,
  showFirstBoardChoice,
  firstBoardChoice,
  fromOnboarding,
  inRangeSection,
  myBoardsSection,
  nearbySection,
  hasBoards,
  onEmptySetUpBoard,
  onEmptyAddSprayWall,
  overlays,
}: {
  scrollBottomPadding: number;
  activeSprayName?: string;
  onActiveBoardDetails: () => void;
  showFirstBoardChoice: boolean;
  firstBoardChoice?: ReactNode;
  fromOnboarding: boolean;
  /** The top of the picker: At {gym}, the hero, or the scan's card; see InRangeSection. */
  inRangeSection?: ReactNode;
  myBoardsSection?: ReactNode;
  nearbySection?: ReactNode;
  hasBoards: boolean;
  /** The empty state's two ways to a first board of their own. */
  onEmptySetUpBoard: () => void;
  onEmptyAddSprayWall: () => void;
  overlays?: ReactNode;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        {activeSprayName != null ? (
          <PressableSurface onPress={onActiveBoardDetails} accessibilityRole="button" style={styles.manageRow}>
            <Text variant="body" color={brandColors.primary} style={styles.manageRowLabel}>
              {t('mobile.boardDetail.activeSprayDetails', { name: activeSprayName })}
            </Text>
            <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        ) : null}
        {showFirstBoardChoice ? (
          <>
            {inRangeSection}
            {firstBoardChoice}
            {/* A new account can already have boards: one it built on the web,
                or one it followed before a sign-out cleared the active board. */}
            {myBoardsSection}
          </>
        ) : (
          <>
            {fromOnboarding ? (
              <Text variant="subheadline" style={styles.onboardingHeader}>
                {t('mobile.onboardingPrompt')}
              </Text>
            ) : null}

            {inRangeSection}

            {hasBoards ? (
              myBoardsSection
            ) : (
              <View style={styles.emptyState}>
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('mobile.emptyTitle')}
                </Text>
                <Text variant="subheadline" style={styles.emptySubtitle}>
                  {t('mobile.emptySubtitle')}
                </Text>
                <View style={styles.emptyActions}>
                  <Button title={t('mobile.addBoard.setUp')} icon="plus" onPress={onEmptySetUpBoard} />
                  <Button
                    title={t('mobile.addBoard.sprayWall')}
                    variant="tonal"
                    icon="camera"
                    onPress={onEmptyAddSprayWall}
                  />
                </View>
              </View>
            )}

            {nearbySection}
          </>
        )}
      </ScrollView>

      {overlays}
    </>
  );
}

export function BoardSelectorSection({
  title,
  trailing,
  children,
}: {
  title: string;
  /** Right-aligned section control or status (Near you's Map, the scan's spinner). */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitle}>
          <Text variant="title3" accessibilityRole="header">
            {title}
          </Text>
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingVertical: spacing[4],
    gap: spacing[5],
  },
  onboardingHeader: {
    paddingHorizontal: spacing[4],
    opacity: 0.7,
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    // Unconditional, so every section keeps one baseline whether or not it
    // has a trailing control.
    minHeight: 44,
  },
  sectionTitle: {
    flex: 1,
  },
  manageRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
  },
  manageRowLabel: {
    flex: 1,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[8],
  },
  emptyTitle: {
    opacity: 0.6,
  },
  emptySubtitle: {
    marginTop: spacing[2],
    opacity: 0.4,
    textAlign: 'center',
  },
  emptyActions: {
    marginTop: spacing[5],
    gap: spacing[2],
    alignItems: 'center',
  },
});
