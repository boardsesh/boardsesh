// The gym map's browse rows, drawn by both of its shells: the root map's
// draggable panel (`GymListPanel`) and the board picker's copy, a map card over
// the list (`GymFinderCardScreen`). A gym row expands to its boards, a board
// row makes that board active, and an expanded gym offers its page, its share
// and, for the person a claim is for, "Claim this gym". Rows come from
// `buildGymListRows` (gym-list-rows.ts).
//
// Every row is memoized and reads its own colours, so a list's `renderItem`
// deps stay free of theme values. The rows carry no gutter: the panel's list
// pads them, the card list wraps each one.

import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { boardConfigLabel, formatBoardDisplayName } from '@boardsesh/board-config';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { namedAccessibilityActions, onNamedAccessibilityAction } from '../../lib/named-accessibility-action';
import { boardTypeLabel } from '../board-discovery/board-builder-labels';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import type { GymListRow } from './gym-list-rows';
import { GymShareButton } from './GymShareButton';
import { GymListingPill } from '../gym-page/GymListingPill';
import { GymListEmptyRow, GymListSectionHeader } from './GymListTextRows';

export type GymBrowseRowHandlers = {
  /** Caption shown under an expanded gym that has no boards yet. */
  noBoardsLabel: string;
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
};

/** One row of the gym map's list, whatever its kind. */
export const GymBrowseRow = memo(function GymBrowseRow({
  row,
  noBoardsLabel,
  onPressGym,
  onActivateBoard,
  onEditGym,
  onEditBoard,
  onClaimGym,
  onOpenGym,
}: GymBrowseRowHandlers & { row: GymListRow }) {
  switch (row.kind) {
    case 'sectionHeader':
      return <GymListSectionHeader label={row.label} />;
    case 'loading':
      return <ActivityIndicator style={styles.listSpinner} />;
    case 'empty':
      return <GymListEmptyRow label={row.label} />;
    case 'gym':
      return (
        <GymRow
          gym={row.gym}
          subtitle={row.subtitle}
          expanded={row.expanded}
          selected={row.selected}
          boards={row.boards}
          boardsPending={row.boardsPending}
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
          board={row.board}
          subtitle={row.subtitle}
          selected={row.selected}
          onActivateBoard={onActivateBoard}
          onEditBoard={onEditBoard}
        />
      );
  }
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
  listSpinner: {
    marginTop: spacing[4],
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
  editButton: {
    padding: spacing[1],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
