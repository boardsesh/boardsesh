import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { boardConfigLabel, formatBoardDisplayName } from '@boardsesh/board-config';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { namedAccessibilityActions, onNamedAccessibilityAction } from '../../lib/named-accessibility-action';
import { boardTypeLabel } from '../board-discovery/board-builder-labels';
import { useTheme } from '../../providers/theme-provider';
import { applySectionCaption } from '../../theme/variants/variant-tokens';
import { sectionHeaderText } from '../section-header-text';
import { spacing, borderRadius, shadows } from '../../theme/tokens';
import { useGymPanelGesture, type GymPanelDetent } from './use-gym-panel-gesture';
import { findRowIndex, type GymListRow } from './gym-list-rows';
import { GymShareButton } from './GymShareButton';
import { GymListingPill } from '../gym-page/GymListingPill';
import { InsetGroupedCell } from '../gym-page/InsetGroupedCell';
import type { GroupedCellPosition } from '../gym-page/gym-page-view-model';
import { ArtRow } from '../ArtRow';
import { StatusPill } from '../StatusPill';

export type GymListPanelHandle = {
  /** Scroll the row carrying this key into view (for a marker tap). */
  scrollToRowKey: (key: string) => void;
  /** Spring to a detent (e.g. nudge Low→Medium when a pin is tapped). */
  snapTo: (detent: GymPanelDetent) => void;
  /** Nudge Low→Medium so a tapped row is visible; never yanks down from Medium/High. */
  ensureVisible: () => void;
};

type GymListPanelSharedProps = {
  data: GymListRow[];
  /** Drives the default detent + whether the Low ("reveal the map") detent exists. */
  mapAvailable: boolean;
  /** The pinned search field (lives in the panel header so it survives a blank map).
   *  Null when the screen pins its search above the map instead. */
  searchSlot: ReactNode;
  /** The "Showing <place>" caption row, when a place is searched. */
  placeCaption?: ReactNode;
  /** Filter chips slot — null until the board-type filter ships. */
  filterSlot?: ReactNode;
  /** Shown in place of the list before a location/place resolves (the search header
   *  stays usable so the user can geocode a place without granting location). */
  locationPrompt?: ReactNode;
  /**
   * The measured height of the box the panel sits in, when it isn't the whole
   * window (a screen that keeps its header bar and a search field above the
   * map). See `useGymPanelGesture`.
   */
  availableHeight?: number;
  /** Fraction of the box the panel covers at its Medium (default) detent. */
  mediumFraction?: number;
  /** Offer the Low ("reveal the map") detent. Default true. */
  allowLowDetent?: boolean;
};

/** /gyms: tap a gym to expand its boards, tap a board to make it active. */
type GymListPanelBrowseProps = GymListPanelSharedProps & {
  mode?: 'browse';
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
  /** Open the gym's own page — shown inside an EXPANDED gym row, under its boards. */
  onOpenGym?: (gym: Gym) => void;
  /** Caption shown under an expanded gym that has no boards yet. */
  noBoardsLabel: string;
};

/**
 * The add-a-board gym step: the rows are gyms to choose (`buildGymPickRows`),
 * one tap each, ending in "Add my gym". Nothing expands, activates or edits.
 */
type GymListPanelPickProps = GymListPanelSharedProps & {
  mode: 'pick';
  onPickGym: (gym: Gym) => void;
  /** "Add my gym": pinned at the bottom of what is visible, at every detent. */
  addGym: { title: string; subtitle: string };
  onAddGym: () => void;
  /** "Try again" under a failed lookup's notice. */
  onRetry?: () => void;
};

export type GymListPanelProps = GymListPanelBrowseProps | GymListPanelPickProps;

const keyExtractor = (row: GymListRow) => row.key;
const getItemType = (row: GymListRow) => row.kind;

/**
 * The "Wall Finder" panel: a NON-MODAL inline draggable sheet pinned over the
 * full-screen gym map. It is a plain sibling View — no scrim, no full-screen
 * touch-catcher — so the uncovered map above it stays pannable. A pinned header
 * (handle + search + filter slot) travels with the sheet; the body is one
 * virtualized FlashList. The drag/scroll handoff lives in {@link useGymPanelGesture}.
 *
 * Two modes: `browse` (/gyms, the default) expands a gym to its boards and
 * activates a board; `pick` (the add-a-board gym step) lists gyms to choose,
 * one tap each, and ends in "Add my gym".
 */
export const GymListPanel = forwardRef<GymListPanelHandle, GymListPanelProps>(function GymListPanel(props, ref) {
  const {
    data,
    mapAvailable,
    searchSlot,
    placeCaption,
    filterSlot,
    locationPrompt,
    availableHeight,
    mediumFraction,
    allowLowDetent,
  } = props;
  const pickMode = props.mode === 'pick';
  // One set of handlers per mode. The other mode's rows never reach renderItem,
  // so its slots are no-ops rather than optional props on every row.
  const onPressGym = props.mode === 'pick' ? noopGym : props.onPressGym;
  const onActivateBoard = props.mode === 'pick' ? noopBoard : props.onActivateBoard;
  const onEditGym = props.mode === 'pick' ? noopGym : props.onEditGym;
  const onEditBoard = props.mode === 'pick' ? noopBoard : props.onEditBoard;
  const onClaimGym = props.mode === 'pick' ? undefined : props.onClaimGym;
  const onOpenGym = props.mode === 'pick' ? undefined : props.onOpenGym;
  const noBoardsLabel = props.mode === 'pick' ? '' : props.noBoardsLabel;
  const onPickGym = props.mode === 'pick' ? props.onPickGym : noopGym;
  const addGym = props.mode === 'pick' ? props.addGym : null;
  const onAddGym = props.mode === 'pick' ? props.onAddGym : noop;
  const onRetry = props.mode === 'pick' ? props.onRetry : undefined;

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
    visibleBottomAnimatedStyle,
    panelHeight,
    scrollEnabled,
    onListScroll,
    onHeaderLayout,
    snapTo,
    ensureVisible,
  } = useGymPanelGesture({ mapAvailable, availableHeight, mediumFraction, allowLow: allowLowDetent });

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
          return pickMode ? (
            <View style={styles.pickGutter}>
              <SectionHeaderRow label={item.label} />
            </View>
          ) : (
            <SectionHeaderRow label={item.label} />
          );
        case 'loading':
          return <ActivityIndicator style={styles.listSpinner} />;
        case 'empty':
          return pickMode ? (
            <View style={styles.pickGutter}>
              <EmptyRow label={item.label} />
              {item.retryLabel && onRetry ? <RetryAction label={item.retryLabel} onPress={onRetry} /> : null}
            </View>
          ) : (
            <EmptyRow label={item.label} />
          );
        case 'gym':
          return (
            <GymRow
              gym={item.gym}
              subtitle={item.subtitle}
              expanded={item.expanded}
              selected={item.selected}
              boards={item.boards}
              boardsPending={item.boardsPending}
              noBoardsLabel={noBoardsLabel}
              onPressGym={onPressGym}
              onActivateBoard={onActivateBoard}
              onEditGym={onEditGym}
              onEditBoard={onEditBoard}
              onClaimGym={onClaimGym}
              onOpenGym={onOpenGym}
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
        case 'pickGym':
          return (
            <PickGymRow
              gym={item.gym}
              subtitle={item.subtitle}
              boardsLabel={item.boardsLabel}
              position={item.position}
              selected={item.selected}
              onPickGym={onPickGym}
            />
          );
      }
    },
    [
      pickMode,
      onRetry,
      noBoardsLabel,
      onPressGym,
      onActivateBoard,
      onEditGym,
      onEditBoard,
      onClaimGym,
      onOpenGym,
      onPickGym,
    ],
  );

  // Pick mode pins "Add my gym" over the list's foot; measured so the last gym
  // can scroll clear of it.
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setFooterHeight((previous) => (previous === measured ? previous : measured));
  }, []);

  // Pick rows are inset-grouped cells that carry their own 16pt gutter.
  const listContentStyle = useMemo(
    () => ({
      paddingHorizontal: pickMode ? 0 : spacing[4],
      paddingBottom: pickMode ? footerHeight + spacing[4] : insets.bottom + spacing[6],
    }),
    [insets.bottom, pickMode, footerHeight],
  );
  const promptAreaStyle = useMemo(
    () => (pickMode ? [styles.promptArea, { paddingBottom: footerHeight + spacing[6] }] : styles.promptArea),
    [pickMode, footerHeight],
  );
  // Pick rows are grouped cards: they sit on the grouped background, so a
  // card's fill reads against it.
  const panelBackground = pickMode ? systemColors.groupedBackground : systemColors.secondaryBackground;

  const cornerStyle = theme.sheet.corners ?? styles.defaultCorners;

  return (
    <Animated.View style={[styles.panel, { height: panelHeight }, panelAnimatedStyle]}>
      <View
        style={[
          styles.surface,
          cornerStyle,
          shadows.lg,
          { backgroundColor: panelBackground, borderTopColor: systemColors.separator },
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
              <View style={promptAreaStyle}>{locationPrompt}</View>
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
                  // Pick mode's search sits above the panel: a row tap while the
                  // keyboard is up should pick the gym, not just close the keyboard.
                  keyboardShouldPersistTaps={pickMode ? 'handled' : undefined}
                  keyboardDismissMode={pickMode ? 'on-drag' : undefined}
                  contentContainerStyle={listContentStyle}
                />
              </GestureDetector>
            )}
            {addGym ? (
              <Animated.View
                style={[
                  styles.pickFooter,
                  { backgroundColor: panelBackground, paddingBottom: insets.bottom + spacing[2] },
                  visibleBottomAnimatedStyle,
                ]}
                onLayout={onFooterLayout}
              >
                <AddGymRow title={addGym.title} subtitle={addGym.subtitle} onAddGym={onAddGym} />
              </Animated.View>
            ) : null}
          </View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
});

// --- rows (memoized; each reads its own colours so renderItem deps stay clean) ---

const SectionHeaderRow = memo(function SectionHeaderRow({ label }: { label: string }) {
  const { systemColors, m3, variant, sectionCaption } = useTheme();
  const caption = applySectionCaption(label, sectionCaption);
  // Same type as SectionHeader: footnote semibold / secondaryLabel on Liquid
  // Glass, titleSmall / onSurfaceVariant on Material.
  const headerText = sectionHeaderText(variant, {
    secondaryLabel: systemColors.secondaryLabel,
    onSurfaceVariant: m3.onSurfaceVariant,
  });
  return (
    <Text
      variant={headerText.textVariant}
      color={headerText.color}
      style={[styles.sectionLabel, caption.style, { fontWeight: headerText.fontWeight }]}
    >
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

const noop = () => {};
const noopGym = (_gym: Gym) => {};
const noopBoard = (_board: UserBoard) => {};

/** The art at the head of a pick row: a gym glyph on a quiet 36pt circle. */
const GymGlyph = memo(function GymGlyph({ icon }: { icon: 'gym' | 'plus' }) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.glyphCircle, { backgroundColor: systemColors.tertiaryFill }]}>
      <Icon name={icon} size={18} color={systemColors.secondaryLabel} />
    </View>
  );
});

const GYM_GLYPH = <GymGlyph icon="gym" />;
const ADD_GLYPH = <GymGlyph icon="plus" />;

/**
 * A gym to choose in pick mode: its name, "1.2 km · street" (left out when
 * there is neither), then how many boards it has and, when its staff run it, "Run by the gym". One slice of an
 * inset-grouped card; the whole row picks.
 */
const PickGymRow = memo(function PickGymRow({
  gym,
  subtitle,
  boardsLabel,
  position,
  selected,
  onPickGym,
}: {
  gym: Gym;
  subtitle: string | null;
  boardsLabel: string;
  position: GroupedCellPosition;
  selected: boolean;
  onPickGym: (gym: Gym) => void;
}) {
  const handlePress = useCallback(() => onPickGym(gym), [onPickGym, gym]);
  const details = useMemo(
    () => (
      <View style={styles.pickDetails}>
        {subtitle ? (
          <Text variant="subheadline" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
        <View style={styles.pickPills}>
          <StatusPill label={boardsLabel} testID="gym-pick-boards" />
          {gym.listingState === 'RUN_BY_GYM' ? (
            <GymListingPill listingState={gym.listingState} testID="gym-pick-listing" />
          ) : null}
        </View>
      </View>
    ),
    [subtitle, boardsLabel, gym.listingState],
  );
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={GYM_GLYPH}
        artSize="compact"
        title={gym.name}
        titleVariant="body"
        subtitle={details}
        accessory="chevron"
        selected={selected}
        onPress={handlePress}
        testID={`gym-pick-${gym.uuid}`}
      />
    </InsetGroupedCell>
  );
});

/** "Try again" under a failed lookup's notice in pick mode. */
const RetryAction = memo(function RetryAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      hitSlop={8}
      style={styles.retry}
      testID="gym-pick-retry"
    >
      <Text variant="subheadline" color={systemColors.accent}>
        {label}
      </Text>
    </PressableSurface>
  );
});

/** Pick mode's pinned footer, its own card: the gym isn't listed, add it. */
const AddGymRow = memo(function AddGymRow({
  title,
  subtitle,
  onAddGym,
}: {
  title: string;
  subtitle: string;
  onAddGym: () => void;
}) {
  return (
    <View style={styles.addGymCard}>
      <InsetGroupedCell position="only" separatorInset="compact">
        <ArtRow
          art={ADD_GLYPH}
          artSize="compact"
          title={title}
          titleVariant="body"
          subtitle={subtitle}
          accessory="chevron"
          onPress={onAddGym}
          testID="gym-pick-add-gym"
        />
      </InsetGroupedCell>
    </View>
  );
});

type GymRowProps = {
  gym: Gym;
  subtitle: string;
  expanded: boolean;
  selected: boolean;
  boards: UserBoard[];
  boardsPending: boolean;
  noBoardsLabel: string;
  onPressGym: (gym: Gym) => void;
  onActivateBoard: (board: UserBoard) => void;
  onEditGym: (gym: Gym) => void;
  onEditBoard: (board: UserBoard) => void;
  onClaimGym?: (gym: Gym) => void;
  onOpenGym?: (gym: Gym) => void;
};

const GymRow = memo(function GymRow({
  gym,
  subtitle,
  expanded,
  selected,
  boards,
  boardsPending,
  noBoardsLabel,
  onPressGym,
  onActivateBoard,
  onEditGym,
  onEditBoard,
  onClaimGym,
  onOpenGym,
}: GymRowProps) {
  const { systemColors, selection } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onPressGym(gym), [onPressGym, gym]);
  const handleEdit = useCallback(() => onEditGym(gym), [onEditGym, gym]);
  const handleClaim = useCallback(() => onClaimGym?.(gym), [onClaimGym, gym]);
  const handleOpenGym = useCallback(() => onOpenGym?.(gym), [onOpenGym, gym]);
  return (
    <View
      style={[
        styles.gymBlock,
        {
          borderColor: selected ? selection.checkmark : systemColors.separator,
          backgroundColor: selected ? selection.fill : undefined,
        },
      ]}
    >
      {selected ? <View style={[styles.selectedAccent, { backgroundColor: selection.checkmark }]} /> : null}
      <View style={styles.gymHeading}>
        <PressableSurface
          onPress={handlePress}
          accessibilityState={{ expanded }}
          accessibilityActions={
            gym.canEdit ? namedAccessibilityActions(EDIT_ACTION_NAME, t('mobile.gyms.editGym')) : undefined
          }
          onAccessibilityAction={gym.canEdit ? onNamedAccessibilityAction(EDIT_ACTION_NAME, handleEdit) : undefined}
          style={[styles.gymRow, styles.gymHeadingMain]}
        >
          <Icon name="pin" size={20} color={selection.text} />
          <View style={styles.rowText}>
            <Text variant="headline" emphasized={selected}>
              {gym.name}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {subtitle}
            </Text>
            {gym.boardTypes.length > 0 ? (
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {gym.boardTypes.map(formatBoardDisplayName).join(' · ')}
              </Text>
            ) : null}
            {/* Who runs it, so a gym's staff can spot a listing that's theirs to claim. */}
            {gym.listingState ? (
              <View style={styles.listingPill}>
                <GymListingPill listingState={gym.listingState} testID="gym-list-listing-pill" />
              </View>
            ) : null}
          </View>
          {gym.canEdit ? <EditButton onPress={handleEdit} label={t('mobile.gyms.editGym')} /> : null}
          <Icon name={expanded ? 'minus' : 'add'} size={20} color={systemColors.tertiaryLabel} />
        </PressableSurface>
        {expanded ? <GymShareButton gym={gym} /> : null}
      </View>

      {expanded ? (
        boards.length > 0 ? (
          boards.map((board) => (
            <BoardRow key={board.uuid} board={board} onActivateBoard={onActivateBoard} onEditBoard={onEditBoard} />
          ))
        ) : boardsPending ? (
          <ActivityIndicator style={styles.listSpinner} />
        ) : (
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.noBoards}>
            {noBoardsLabel}
          </Text>
        )
      ) : null}

      {/* The gym's own page: who runs it, every board, its details and the claim. */}
      {expanded && onOpenGym ? (
        <SeeGymRow
          onPress={handleOpenGym}
          label={t('mobile.gyms.seeGym')}
          accessibilityLabel={t('mobile.gyms.seeGymAria', { gym: gym.name })}
        />
      ) : null}

      {/* The claim entry for the person a claim is FOR — a real gym owner with no
          Boardsesh rights yet (canClaim true, canEdit false). Only inside the
          expanded row so it never clutters the collapsed finder list. Never on a
          gym its staff run: nobody can claim one, and the server says so too. */}
      {expanded && gym.canClaim && gym.listingState !== 'RUN_BY_GYM' && onClaimGym ? (
        <ClaimRow onPress={handleClaim} label={t('mobile.gymClaim.claimAction')} />
      ) : null}
    </View>
  );
});

/**
 * "See gym" under an expanded gym's boards: opens the gym's page. Reads its own
 * colours so the parent's `renderItem` deps stay free of theme values.
 */
const SeeGymRow = memo(function SeeGymRow({
  onPress,
  label,
  accessibilityLabel,
}: {
  onPress: () => void;
  label: string;
  accessibilityLabel: string;
}) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[styles.claimRow, { borderTopColor: systemColors.separator }]}
      testID="gym-list-see-gym"
    >
      <Icon name="gym" size={18} color={systemColors.accent} />
      <Text variant="subheadline" color={systemColors.accent} style={styles.seeGymLabel}>
        {label}
      </Text>
      <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );
});

/**
 * The "Claim this gym" action shown at the foot of an expanded gym row. Reads its
 * own colours so the parent's `renderItem` deps stay free of theme values; the
 * label is resolved by the caller (a literal `t(...)`) so the i18n key stays static.
 */
const ClaimRow = memo(function ClaimRow({ onPress, label }: { onPress: () => void; label: string }) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.claimRow, { borderTopColor: systemColors.separator }]}
    >
      <Icon name="person.badge.plus" size={18} color={systemColors.accent} />
      <Text variant="subheadline" color={systemColors.accent}>
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
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onActivateBoard(board), [onActivateBoard, board]);
  const handleEdit = useCallback(() => onEditBoard(board), [onEditBoard, board]);
  return (
    <PressableSurface
      onPress={handlePress}
      accessibilityActions={
        board.canEdit ? namedAccessibilityActions(EDIT_ACTION_NAME, t('mobile.gyms.editBoard')) : undefined
      }
      onAccessibilityAction={board.canEdit ? onNamedAccessibilityAction(EDIT_ACTION_NAME, handleEdit) : undefined}
      style={[styles.boardRow, { borderTopColor: systemColors.separator }]}
    >
      <Icon name="boards" size={18} color={systemColors.secondaryLabel} />
      <View style={styles.rowText}>
        <Text variant="subheadline">{board.name}</Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {/* Inside an expanded gym the place is redundant — show what the board
              is instead, never the raw lowercase type. */}
          {boardConfigLabel(board) ?? boardTypeLabel(board.boardType)}
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
  const { systemColors, selection } = useTheme();
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onActivateBoard(board), [onActivateBoard, board]);
  const handleEdit = useCallback(() => onEditBoard(board), [onEditBoard, board]);
  return (
    <View
      style={[
        styles.gymBlock,
        {
          borderColor: selected ? selection.checkmark : systemColors.separator,
          backgroundColor: selected ? selection.fill : undefined,
        },
      ]}
    >
      {selected ? <View style={[styles.selectedAccent, { backgroundColor: selection.checkmark }]} /> : null}
      <PressableSurface
        onPress={handlePress}
        accessibilityActions={
          board.canEdit ? namedAccessibilityActions(EDIT_ACTION_NAME, t('mobile.gyms.editBoard')) : undefined
        }
        onAccessibilityAction={board.canEdit ? onNamedAccessibilityAction(EDIT_ACTION_NAME, handleEdit) : undefined}
        style={styles.standaloneRow}
      >
        <Icon name="boards" size={20} color={selection.text} />
        <View style={styles.rowText}>
          <Text variant="headline" emphasized={selected}>
            {board.name}
          </Text>
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

const EDIT_ACTION_NAME = 'edit';

/**
 * The pencil affordance shown on a row the viewer can edit. Reads its own colour
 * so the parent rows' `renderItem` deps stay free of theme values; the label is
 * resolved by the caller (a literal `t(...)`) so the i18n key stays static.
 */
const EditButton = memo(function EditButton({ onPress, label }: { onPress: () => void; label: string }) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.editButton}
    >
      <Icon name="edit" size={18} color={systemColors.secondaryLabel} />
    </PressableSurface>
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
    // Above the list, so the search field's floating town suggestions draw over it.
    zIndex: 1,
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
  gymHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: spacing[2],
  },
  gymHeadingMain: {
    flex: 1,
    minWidth: 0,
  },
  rowText: {
    flex: 1,
  },
  listingPill: {
    flexDirection: 'row',
    marginTop: spacing[1],
  },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    paddingStart: spacing[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  noBoards: {
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[3],
    paddingStart: spacing[6],
  },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    paddingStart: spacing[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  seeGymLabel: {
    flex: 1,
  },
  standaloneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
  },
  pickGutter: {
    paddingHorizontal: spacing[4],
  },
  glyphCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickDetails: {
    gap: spacing[1],
  },
  pickPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[1],
  },
  addGymCard: {
    paddingTop: spacing[2],
  },
  pickFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  retry: {
    alignSelf: 'center',
    marginTop: spacing[2],
    paddingVertical: spacing[1],
  },
  editButton: {
    padding: spacing[1],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
