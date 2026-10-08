import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UserBoard } from '@boardsesh/shared-schema';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardCarousel } from '../board-discovery/BoardCarousel';
import type { DiscoveryBoardItem } from '../board-discovery/BoardDiscoveryCard';
import { userBoardsToItems } from '../board-discovery/board-items';
import { useSprayLabelOptions } from '../../lib/spray/use-spray-label-options';
import { sortViewerOwnedFirst } from '../board-discovery/board-card-actions';
import { useBoardOfflineState } from '../board-discovery/use-board-offline-state';
import { useOnboardingBoardCopy } from '../../lib/onboarding/use-onboarding-copy';
import { useBlockBack } from './use-block-back';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

export type OnboardingBoardStepProps = {
  /** Body/subtext colour. */
  bodyColor: string;
  /** Opaque background under the reading text. */
  backgroundColor: string;
  /** The climber's own boards. Empty while loading, and empty on a failed load. */
  boards: UserBoard[];
  /** The board list request is still in flight. */
  isLoading: boolean;
  /** Whether the offline engine can offer a download at all (platform gate). */
  offlineDownloadsEnabled: boolean;
  /** Signed-in user id, so the carousel can put viewer-owned boards first. */
  currentUserId: string | undefined;
  /**
   * The one condition under which this step may be left without a board: no
   * usable connection AND nothing cached to choose from. `null` when there is no
   * such dead end, which is the normal case.
   */
  onSkipUnusable: (() => void) | null;
  /** Bind this board and move on. */
  onSelect: (board: UserBoard) => void;
  /** Download this board without binding it. */
  onDownload: (board: UserBoard) => void;
  /** Hand off to the full /boards picker. */
  onFindBoard: () => void;
};

/**
 * "Which board do you climb on?" — the second onboarding step, and the one that
 * makes the whole flow worth being mandatory.
 *
 * Two things happen here beyond picking a board. It **names the mechanism**:
 * board history is shared per named board, so which board you pick is what
 * decides whose sends you see. And it **offers the download**, because a board
 * on the phone opens instantly and works on gym wifi that has given up.
 *
 * Reuses `BoardCarousel` / `BoardDiscoveryCard` rather than growing a second
 * board slider — same cards, same download glyph, same active tick as `/boards`.
 *
 * **There is no exit** (issue #4961), with exactly one exception: a climber who
 * is offline with nothing cached cannot be shown a usable choice, and stranding
 * them on a screen that can never resolve is worse than letting them past.
 * `onSkipUnusable` is that hatch, and it deliberately does not mark onboarding
 * complete — the gate brings them back on the next launch, when the network may
 * be there.
 */
export function OnboardingBoardStep({
  bodyColor,
  backgroundColor,
  boards,
  isLoading,
  offlineDownloadsEnabled,
  currentUserId,
  onSkipUnusable,
  onSelect,
  onDownload,
  onFindBoard,
}: OnboardingBoardStepProps) {
  const copy = useOnboardingBoardCopy();
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();

  useBlockBack();

  const boardOfflineState = useBoardOfflineState();
  const labelOptions = useSprayLabelOptions();
  const items = useMemo(
    () =>
      userBoardsToItems(sortViewerOwnedFirst(boards, currentUserId), {
        activeUuid: null,
        offlineStateFor: boardOfflineState,
        currentUserId,
        labelOptions,
      }),
    [boards, boardOfflineState, currentUserId, labelOptions],
  );

  // Both handlers resolve the item back to its UserBoard. A refetch that drops a
  // board between render and tap is the only way to miss, and the right answer
  // there is to do nothing rather than bind something else.
  const findBoard = useCallback((key: string) => boards.find((board) => board.uuid === key), [boards]);

  const handleSelect = useCallback(
    (item: DiscoveryBoardItem) => {
      const board = findBoard(item.key);
      if (board) onSelect(board);
    },
    [findBoard, onSelect],
  );

  const handleDownload = useCallback(
    (item: DiscoveryBoardItem) => {
      const board = findBoard(item.key);
      if (board) onDownload(board);
    },
    [findBoard, onDownload],
  );

  const downloadLabelFor = useCallback((item: DiscoveryBoardItem) => copy.downloadLabelFor(item.title), [copy]);

  const hasBoards = items.length > 0;

  // The route hides the native header (a transparentModal), so the step draws
  // its own top bar. With boards on screen, tapping a card is the answer and the
  // picker is the alternative, so the trailing action is plain; with none,
  // including a list that failed to load, the picker is the only way forward and
  // is the prominent confirm. Never a dead end. The offline hatch is a decline,
  // so it takes the leading slot, where iOS puts "Not Now".
  return (
    <View style={[styles.root, { backgroundColor, paddingTop: insets.top }]} accessibilityViewIsModal>
      <SheetTopBar
        title=""
        leading={onSkipUnusable ? { kind: 'cancel', label: copy.offlineSkip, onPress: onSkipUnusable } : undefined}
        trailing={{
          kind: 'forward',
          label: hasBoards ? copy.findAnother : copy.findFirst,
          onPress: onFindBoard,
          prominent: !hasBoards,
        }}
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.copy}>
          <Text variant="title1">{copy.title}</Text>
          <Text variant="body" color={bodyColor} style={styles.description}>
            {copy.body}
          </Text>
        </View>

        {isLoading && !hasBoards ? (
          <View style={styles.spinner}>
            <ActivityIndicator />
          </View>
        ) : null}

        {hasBoards ? (
          <>
            <BoardCarousel
              items={items}
              onSelect={handleSelect}
              onDownload={offlineDownloadsEnabled ? handleDownload : undefined}
              downloadLabelFor={downloadLabelFor}
            />
            {offlineDownloadsEnabled ? (
              <View style={styles.copy}>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
                  {copy.offlineHint}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  body: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing[5],
    paddingVertical: spacing[5],
  },
  copy: {
    paddingHorizontal: spacing[5],
    gap: spacing[2],
  },
  description: {
    lineHeight: 20,
  },
  spinner: {
    paddingVertical: spacing[8],
    alignItems: 'center',
  },
});
