import { useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SHELF_SECTION_GAP } from '../ShelfHeader';
import { Text } from '../Text';
import { PickerTouchContext } from './picker-touch';

/**
 * The board picker's body (#5654 and the 2026-11 redesign), top to bottom:
 * the top (At {gym}, the board heard somewhere else, or what the scan needs;
 * see picker-top-view.ts), Near you, Your boards (or the empty state), and the
 * location banner. The screen hands in Near you only once location is
 * allowed, and the banner only while it is not, so one of the two shows. First
 * run swaps all three for "Where do you climb?" under the top. The ways to add
 * a board live in the screen's top bar.
 *
 * Presentational: the screen hands in each section ready-made. Sections are
 * `ShelfSection`s and own their spacing (8pt under a title, 28pt to the next);
 * anything here that isn't a shelf keeps the same 28pt under it.
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
  locationBanner,
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
  /** Near you, above Your boards. Only with location allowed. */
  nearbySection?: ReactNode;
  /** The way to turn location on, at the foot of the picker, in place of Near you. */
  locationBanner?: ReactNode;
  hasBoards: boolean;
  /** The empty state's two ways to a first board of their own. */
  onEmptySetUpBoard: () => void;
  onEmptyAddSprayWall: () => void;
  overlays?: ReactNode;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  // The climber's first touch, a tap or a drag: until then Near you may give
  // back space it held (NearbyReservedSlot), since no finger is on its way.
  const touched = useRef(false);
  const noteTouch = useCallback(() => {
    touched.current = true;
  }, []);
  return (
    <PickerTouchContext value={touched}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding }]}
        showsVerticalScrollIndicator={false}
        onTouchStart={noteTouch}
        onScrollBeginDrag={noteTouch}
      >
        {activeSprayName != null ? (
          <PressableSurface
            onPress={onActiveBoardDetails}
            accessibilityRole="button"
            style={[styles.detailsRow, styles.block]}
          >
            <Text variant="body" color={systemColors.accent} style={styles.detailsLabel}>
              {t('mobile.boardDetail.activeSprayDetails', { name: activeSprayName })}
            </Text>
            <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        ) : null}
        {showFirstBoardChoice ? (
          <>
            {inRangeSection}
            <View style={styles.block}>{firstBoardChoice}</View>
            {/* A new account can already have boards: one it built on the web,
                or one it followed before a sign-out cleared the active board. */}
            {myBoardsSection}
          </>
        ) : (
          <>
            {fromOnboarding ? (
              <Text variant="subheadline" tone="secondary" style={[styles.onboardingHeader, styles.block]}>
                {t('mobile.onboardingPrompt')}
              </Text>
            ) : null}

            {inRangeSection}

            {nearbySection}

            {hasBoards ? (
              myBoardsSection
            ) : (
              <EmptyState
                size="section"
                title={t('mobile.emptyTitle')}
                body={t('mobile.emptySubtitle')}
                actions={
                  <>
                    <Button title={t('mobile.addBoard.setUp')} icon="plus" onPress={onEmptySetUpBoard} />
                    <Button
                      title={t('mobile.addBoard.sprayWall')}
                      variant="tonal"
                      icon="camera"
                      onPress={onEmptyAddSprayWall}
                    />
                  </>
                }
              />
            )}

            {locationBanner}
          </>
        )}
      </ScrollView>

      {overlays}
    </PickerTouchContext>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingTop: spacing[4],
  },
  // What isn't a shelf keeps the shelves' rhythm below it.
  block: {
    marginBottom: SHELF_SECTION_GAP,
  },
  onboardingHeader: {
    paddingHorizontal: spacing[4],
  },
  detailsRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
  },
  detailsLabel: {
    flex: 1,
  },
});
