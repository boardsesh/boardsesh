import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { BoardModeCard, type ModeCardState } from './BoardModeCard';
export function BoardSelectorView({
  scrollBottomPadding,
  activeSprayName,
  onActiveBoardDetails,
  showFirstBoardChoice,
  firstBoardChoice,
  myBoardsSection,
  fromOnboarding,
  nearbySearch,
  nearbyState,
  onModeFindNearby,
  onModeBluetooth,
  onModeFindGym,
  onModeCreate,
  onModeAddWall,
  nearbyStatus,
  nearbySection,
  popularSection,
  hasBoards,
  overlays,
}: {
  scrollBottomPadding: number;
  activeSprayName?: string;
  onActiveBoardDetails: () => void;
  showFirstBoardChoice: boolean;
  firstBoardChoice?: ReactNode;
  myBoardsSection?: ReactNode;
  fromOnboarding: boolean;
  nearbySearch: string;
  nearbyState: ModeCardState;
  onModeFindNearby: () => void;
  onModeBluetooth: () => void;
  onModeFindGym: () => void;
  onModeCreate: () => void;
  onModeAddWall: () => void;
  nearbyStatus?: ReactNode;
  nearbySection?: ReactNode;
  popularSection?: ReactNode;
  hasBoards: boolean;
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
            {firstBoardChoice}
            {/* A new account can already have boards: one it built on the web,
                or one it followed before a sign-out cleared the active board.
                No Popular setups here: each of those cards builds a NEW public
                board, which is how a gym climber ends up with a duplicate of
                their gym's wall. My own board covers the home-wall case. */}
            {myBoardsSection}
          </>
        ) : (
          <>
            {fromOnboarding ? (
              <Text variant="subheadline" style={styles.onboardingHeader}>
                {t('mobile.onboardingPrompt')}
              </Text>
            ) : null}

            {/* Mode cards */}
            <View style={styles.modeRow}>
              <BoardModeCard
                icon="location"
                label={t('mobile.discovery.findNearby')}
                sublabel={
                  nearbySearch === 'location_off'
                    ? t('mobile.discovery.locationDenied')
                    : nearbySearch === 'found'
                      ? t('mobile.discovery.nearbyShowing')
                      : undefined
                }
                state={nearbyState}
                onPress={onModeFindNearby}
              />
              <BoardModeCard icon="bluetooth" label={t('mobile.discovery.bluetooth')} onPress={onModeBluetooth} />
              <BoardModeCard icon="pin" label={t('mobile.discovery.findGym')} onPress={onModeFindGym} />
              {/* The tile is 84 dp wide (68 dp of text): "Create board" truncated in
                  en-US and in all three other locales. The `+` glyph and the row's
                  context carry the noun here; the full-width CTAs keep it. */}
              <BoardModeCard icon="plus" label={t('mobile.discovery.createTile')} onPress={onModeCreate} />
              {/* Next to "Create board", because that is the question it answers: the
                  other tile is for a catalogue board you pick a layout for, this one
                  is for a wall you photograph. */}
              <BoardModeCard icon="camera" label={t('mobile.discovery.addWallTile')} onPress={onModeAddWall} />
            </View>

            {/* Find nearby's answer when it has no list to show. Not while it
                searches: the tile's own spinner says that. */}
            {nearbyStatus}

            {nearbySection}
            {myBoardsSection}

            {popularSection}

            {!hasBoards ? (
              <View style={styles.emptyState}>
                <Text variant="headline" style={styles.emptyTitle}>
                  {t('mobile.emptyTitle')}
                </Text>
                <Text variant="subheadline" style={styles.emptySubtitle}>
                  {t('mobile.emptySubtitle')}
                </Text>
                <Button title={t('mobile.discovery.create')} onPress={onModeCreate} style={styles.emptyCta} />
              </View>
            ) : null}
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
  /** Right-aligned section control (the "Your boards" Edit/Done toggle). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text variant="title3" style={styles.sectionTitle}>
          {title}
        </Text>
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
  offlineNotice: {
    paddingHorizontal: spacing[4],
    opacity: 0.7,
  },
  modeRow: {
    flexDirection: 'row',
    // 8 dp, not 12: five tiles share the row, and every point of gap is a
    // point the labels lose (#5960).
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    // Unconditional, so Near you / Your boards / Popular keep one baseline and
    // the layout does not jump when the Edit control appears.
    minHeight: 44,
  },
  sectionTitle: {
    flex: 1,
  },
  sectionAction: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
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
  centered: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateSubtitle: {
    marginTop: spacing[1],
    textAlign: 'center',
    opacity: 0.6,
  },
  stateButton: {
    marginTop: spacing[4],
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
  emptyCta: {
    marginTop: spacing[5],
  },
});
