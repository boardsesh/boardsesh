import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { applySectionCaption } from '../../theme/variants/variant-tokens';
import { spacing, borderRadius, shadows } from '../../theme/tokens';
import { useGymPanelGesture, type GymPanelDetent } from './use-gym-panel-gesture';
import { findRowIndex, type GymListRow } from './gym-list-rows';

export type GymListPanelHandle = {
  /** Scroll the row carrying this key into view (for a marker tap). */
  scrollToRowKey: (key: string) => void;
  /** Spring to a detent (e.g. nudge Low→Medium when a pin is tapped). */
  snapTo: (detent: GymPanelDetent) => void;
  /** Nudge Low→Medium so a tapped row is visible; never yanks down from Medium/High. */
  ensureVisible: () => void;
};

type GymListPanelProps = {
  data: GymListRow[];
  /** Drives the default detent + whether the Low ("reveal the map") detent exists. */
  mapAvailable: boolean;
  /** Tap/expand a gym row — the screen toggles expansion, selects it, recenters the map. */
  onPressGym: (gym: Gym) => void;
  /** Tap a board (under a gym, or a standalone) — makes it active. */
  onActivateBoard: (board: UserBoard) => void;
  /** Edit a gym the viewer can edit — only shown on rows whose `gym.canEdit` is true. */
  onEditGym: (gym: Gym) => void;
  /** Edit a board the viewer can edit — only shown on rows whose `board.canEdit` is true. */
  onEditBoard: (board: UserBoard) => void;
  /** Start an ownership claim — shown inside an EXPANDED gym row whose `gym.canClaim`
   *  is true. Kept off collapsed rows (almost every signed-in viewer can claim almost
   *  any gym, so a per-row button would clutter the finder). */
  onClaimGym?: (gym: Gym) => void;
  /** Caption shown under an expanded gym that has no boards yet. */
  noBoardsLabel: string;
  /** The pinned search field (lives in the panel header so it survives a blank map). */
  searchSlot: ReactNode;
  /** The "Showing <place>" caption row, when a place is searched. */
  placeCaption?: ReactNode;
  /** Filter chips slot — null until the board-type filter ships. */
  filterSlot?: ReactNode;
  /** Shown in place of the list before a location/place resolves (the search header
   *  stays usable so the user can geocode a place without granting location). */
  locationPrompt?: ReactNode;
};

const keyExtractor = (row: GymListRow) => row.key;
const getItemType = (row: GymListRow) => row.kind;

/**
 * The "Wall Finder" panel: a NON-MODAL inline draggable sheet pinned over the
 * full-screen gym map. It is a plain sibling View — no scrim, no full-screen
 * touch-catcher — so the uncovered map above it stays pannable. A pinned header
 * (handle + search + filter slot) travels with the sheet; the body is one
 * virtualized FlashList. The drag/scroll handoff lives in {@link useGymPanelGesture}.
 */
export const GymListPanel = forwardRef<GymListPanelHandle, GymListPanelProps>(function GymListPanel(
  {
    data,
    mapAvailable,
    onPressGym,
    onActivateBoard,
    onEditGym,
    onEditBoard,
    onClaimGym,
    noBoardsLabel,
    searchSlot,
    placeCaption,
    filterSlot,
    locationPrompt,
  },
  ref,
) {
  const theme = useTheme();
  const { systemColors } = theme;
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<GymListRow>>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const {
    gesture,
    nativeGesture,
    panelAnimatedStyle,
    panelHeight,
    scrollEnabled,
    onListScroll,
    onHeaderLayout,
    snapTo,
    ensureVisible,
  } = useGymPanelGesture({ mapAvailable });

  useImperativeHandle(
    ref,
    () => ({
      scrollToRowKey: (key: string) => {
        const index = findRowIndex(dataRef.current, key);
        if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
      },
      snapTo,
      ensureVisible,
    }),
    [snapTo, ensureVisible],
  );

  const renderItem = useCallback(
    ({ item }: { item: GymListRow }) => {
      switch (item.kind) {
        case 'sectionHeader':
          return <SectionHeaderRow label={item.label} />;
        case 'loading':
          return <ActivityIndicator style={styles.listSpinner} />;
        case 'empty':
          return <EmptyRow label={item.label} />;
        case 'gym':
          return (
            <GymRow
              gym={item.gym}
              subtitle={item.subtitle}
              expanded={item.expanded}
              selected={item.selected}
              boards={item.boards}
              noBoardsLabel={noBoardsLabel}
              onPressGym={onPressGym}
              onActivateBoard={onActivateBoard}
              onEditGym={onEditGym}
              onEditBoard={onEditBoard}
              onClaimGym={onClaimGym}
            />
          );
        case 'standalone':
          return (
            <StandaloneRow
              board={item.board}
              subtitle={item.subtitle}
              selected={item.selected}
              onActivateBoard={onActivateBoard}
              onEditBoard={onEditBoard}
            />
          );
      }
    },
    [noBoardsLabel, onPressGym, onActivateBoard, onEditGym, onEditBoard, onClaimGym],
  );

  const listContentStyle = useMemo(
    () => ({ paddingHorizontal: spacing[4], paddingBottom: insets.bottom + spacing[6] }),
    [insets.bottom],
  );

  const cornerStyle = theme.sheet.corners ?? styles.defaultCorners;

  return (
    <Animated.View style={[styles.panel, { height: panelHeight }, panelAnimatedStyle]}>
      <View
        style={[
          styles.surface,
          cornerStyle,
          shadows.lg,
          { backgroundColor: systemColors.secondaryBackground, borderTopColor: systemColors.separator },
        ]}
      >
        <GestureDetector gesture={gesture}>
          <View style={styles.fill}>
            <View style={styles.header} onLayout={onHeaderLayout}>
              <View style={[styles.handle, theme.sheet.handleStyle]} />
              {searchSlot}
              {placeCaption}
              {filterSlot}
            </View>
            {locationPrompt ? (
              <View style={styles.promptArea}>{locationPrompt}</View>
            ) : (
              <GestureDetector gesture={nativeGesture}>
                <FlashList
                  ref={listRef}
                  data={data}
                  renderItem={renderItem}
                  keyExtractor={keyExtractor}
                  getItemType={getItemType}
                  scrollEnabled={scrollEnabled}
                  onScroll={onListScroll}
                  scrollEventThrottle={16}
                  bounces={false}
                  overScrollMode="never"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={listContentStyle}
                />
              </GestureDetector>
            )}
          </View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
});

// --- rows (memoized; each reads its own colours so renderItem deps stay clean) ---

const SectionHeaderRow = memo(function SectionHeaderRow({ label }: { label: string }) {
  const { systemColors, sectionCaption } = useTheme();
  const caption = applySectionCaption(label, sectionCaption);
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={[styles.sectionLabel, caption.style]}>
      {caption.text}
    </Text>
  );
});

const EmptyRow = memo(function EmptyRow({ label }: { label: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.empty}>
      {label}
    </Text>
  );
});

type GymRowProps = {
  gym: Gym;
  subtitle: string;
  expanded: boolean;
  selected: boolean;
  boards: UserBoard[];
  noBoardsLabel: string;
  onPressGym: (gym: Gym) => void;
  onActivateBoard: (board: UserBoard) => void;
  onEditGym: (gym: Gym) => void;
  onEditBoard: (board: UserBoard) => void;
  onClaimGym?: (gym: Gym) => void;
};

const GymRow = memo(function GymRow({
  gym,
  subtitle,
  expanded,
  selected,
  boards,
  noBoardsLabel,
  onPressGym,
  onActivateBoard,
  onEditGym,
  onEditBoard,
  onClaimGym,
}: GymRowProps) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onPressGym(gym), [onPressGym, gym]);
  const handleEdit = useCallback(() => onEditGym(gym), [onEditGym, gym]);
  const handleClaim = useCallback(() => onClaimGym?.(gym), [onClaimGym, gym]);
  return (
    <View style={[styles.gymBlock, { borderColor: selected ? brandColors.primary : systemColors.separator }]}>
      {selected ? <View style={[styles.selectedAccent, { backgroundColor: brandColors.primary }]} /> : null}
      <PressableSurface
        onPress={handlePress}
        rippleColor={brandColors.primary}
        accessibilityState={{ expanded }}
        style={styles.gymRow}
      >
        <Icon name="pin" size={20} color={selected ? brandColors.primary : systemColors.label} />
        <View style={styles.rowText}>
          <Text variant="headline">{gym.name}</Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {subtitle}
          </Text>
          {gym.boardTypes.length > 0 ? (
            <Text variant="caption1" color={systemColors.tertiaryLabel}>
              {gym.boardTypes.map(formatBoardDisplayName).join(' · ')}
            </Text>
          ) : null}
        </View>
        {gym.canEdit ? <EditButton onPress={handleEdit} label={t('mobile.gyms.editGym')} /> : null}
        <Icon name={expanded ? 'minus' : 'add'} size={20} color={systemColors.tertiaryLabel} />
      </PressableSurface>

      {expanded ? (
        boards.length > 0 ? (
          boards.map((board) => (
            <BoardRow key={board.uuid} board={board} onActivateBoard={onActivateBoard} onEditBoard={onEditBoard} />
          ))
        ) : (
          <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.noBoards}>
            {noBoardsLabel}
          </Text>
        )
      ) : null}

      {/* The claim entry for the person a claim is FOR — a real gym owner with no
          Boardsesh rights yet (canClaim true, canEdit false). Only inside the
          expanded row so it never clutters the collapsed finder list. */}
      {expanded && gym.canClaim && onClaimGym ? (
        <ClaimRow onPress={handleClaim} label={t('mobile.gymClaim.claimAction')} />
      ) : null}
    </View>
  );
});

/**
 * The "Claim this gym" action shown at the foot of an expanded gym row. Reads its
 * own colours so the parent's `renderItem` deps stay free of theme values; the
 * label is resolved by the caller (a literal `t(...)`) so the i18n key stays static.
 */
const ClaimRow = memo(function ClaimRow({ onPress, label }: { onPress: () => void; label: string }) {
  const { systemColors, brandColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      rippleColor={brandColors.primary}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.claimRow, { borderTopColor: systemColors.separator }]}
    >
      <Icon name="person.badge.plus" size={18} color={brandColors.primary} />
      <Text variant="subheadline" color={brandColors.primary}>
        {label}
      </Text>
    </PressableSurface>
  );
});

const BoardRow = memo(function BoardRow({
  board,
  onActivateBoard,
  onEditBoard,
}: {
  board: UserBoard;
  onActivateBoard: (board: UserBoard) => void;
  onEditBoard: (board: UserBoard) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onActivateBoard(board), [onActivateBoard, board]);
  const handleEdit = useCallback(() => onEditBoard(board), [onEditBoard, board]);
  return (
    <PressableSurface
      onPress={handlePress}
      rippleColor={brandColors.primary}
      style={[styles.boardRow, { borderTopColor: systemColors.separator }]}
    >
      <Icon name="boards" size={18} color={systemColors.secondaryLabel} />
      <View style={styles.rowText}>
        <Text variant="subheadline">{board.name}</Text>
        <Text variant="caption1" color={systemColors.tertiaryLabel}>
          {board.boardType}
        </Text>
      </View>
      {board.canEdit ? <EditButton onPress={handleEdit} label={t('mobile.gyms.editBoard')} /> : null}
    </PressableSurface>
  );
});

const StandaloneRow = memo(function StandaloneRow({
  board,
  subtitle,
  selected,
  onActivateBoard,
  onEditBoard,
}: {
  board: UserBoard;
  subtitle: string;
  selected: boolean;
  onActivateBoard: (board: UserBoard) => void;
  onEditBoard: (board: UserBoard) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onActivateBoard(board), [onActivateBoard, board]);
  const handleEdit = useCallback(() => onEditBoard(board), [onEditBoard, board]);
  return (
    <View style={[styles.gymBlock, { borderColor: selected ? brandColors.primary : systemColors.separator }]}>
      {selected ? <View style={[styles.selectedAccent, { backgroundColor: brandColors.primary }]} /> : null}
      <PressableSurface onPress={handlePress} rippleColor={brandColors.primary} style={styles.standaloneRow}>
        <Icon name="boards" size={20} color={selected ? brandColors.primary : systemColors.label} />
        <View style={styles.rowText}>
          <Text variant="headline">{board.name}</Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {subtitle}
          </Text>
        </View>
        {board.canEdit ? <EditButton onPress={handleEdit} label={t('mobile.gyms.editBoard')} /> : null}
        <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
      </PressableSurface>
    </View>
  );
});

/**
 * The pencil affordance shown on a row the viewer can edit. Reads its own colour
 * so the parent rows' `renderItem` deps stay free of theme values; the label is
 * resolved by the caller (a literal `t(...)`) so the i18n key stays static.
 */
const EditButton = memo(function EditButton({ onPress, label }: { onPress: () => void; label: string }) {
  const { systemColors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.editButton}
    >
      <Icon name="edit" size={18} color={systemColors.secondaryLabel} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  surface: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  defaultCorners: {
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
  },
  fill: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[2],
  },
  handle: {
    alignSelf: 'center',
    marginBottom: spacing[2],
  },
  sectionLabel: {
    marginBottom: spacing[1],
    marginTop: spacing[2],
  },
  empty: {
    marginTop: spacing[4],
    textAlign: 'center',
  },
  listSpinner: {
    marginTop: spacing[4],
  },
  promptArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    padding: spacing[6],
  },
  gymBlock: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing[2],
  },
  selectedAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    zIndex: 1,
  },
  gymRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
  },
  rowText: {
    flex: 1,
  },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    paddingLeft: spacing[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  noBoards: {
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[3],
    paddingLeft: spacing[6],
  },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    paddingLeft: spacing[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  standaloneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
  },
  editButton: {
    padding: spacing[1],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
