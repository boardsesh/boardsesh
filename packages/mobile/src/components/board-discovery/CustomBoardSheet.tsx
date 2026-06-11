import { forwardRef, useEffect, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import type BottomSheet from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS, ANGLES, normaliseSetIds } from '@boardsesh/board-config';
import { useCreateBoard } from '../../lib/graphql/hooks';
import { createGuestActiveBoard } from '../../lib/boards/guest-board';
import {
  getBoardLayouts,
  getBoardSizesForLayoutId,
  getBoardSetsForLayoutAndSize,
  getDefaultBoardSizeForLayout,
} from '../../lib/custom-board-options';
import { findOwnedBoardForConfig } from './board-items';
import { spacing, borderRadius } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { useTheme } from '../../providers/theme-provider';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Button } from '../Button';

/** A board config to pre-fill the builder with (e.g. a tapped Popular setup). */
export type BoardSeed = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids. */
  setIds: string;
  angle?: number;
};

type CustomBoardSheetProps = {
  /** When set, the builder opens pre-filled with this config (else a blank form). */
  seed?: BoardSeed | null;
  /** The user's existing boards, so an already-owned config activates instead
   *  of erroring on the server's duplicate-config guard. */
  existingBoards: UserBoard[];
  /** Resolves once the board is created server-side (CREATE_BOARD). */
  onCreated: (board: UserBoard) => void;
  /** The picked config matches a board the user already owns — activate it. */
  onSelectExisting: (board: UserBoard) => void;
  isAuthenticated: boolean;
  onError: () => void;
};

/**
 * Custom-board builder: cascading board → layout → size → sets → angle, driven
 * entirely by static `@boardsesh/board-config` + `@boardsesh/board-constants`
 * data (no server query). Signed-in users persist the config via CREATE_BOARD
 * unless they already own that exact config; guests get a local active board
 * with a synthetic uuid so they can browse and drive a wall without an account.
 */
export const CustomBoardSheet = forwardRef<BottomSheet, CustomBoardSheetProps>(function CustomBoardSheet(
  { seed, existingBoards, onCreated, onSelectExisting, isAuthenticated, onError },
  ref,
) {
  const { systemColors, brandColors: themeBrandColors } = useTheme();
  const { t } = useTranslation('boards');
  const createBoard = useCreateBoard();

  const [boardName, setBoardName] = useState<BoardName>(SUPPORTED_BOARDS[0]);
  const [layoutId, setLayoutId] = useState<number | null>(null);
  const [sizeId, setSizeId] = useState<number | null>(null);
  const [setIds, setSetIds] = useState<number[]>([]);
  const [angle, setAngle] = useState<number>(40);

  // Start fresh on each open: dismissing a half-configured builder and
  // reopening it should present a clean slate, not stale selections.
  const resetForm = () => {
    setBoardName(SUPPORTED_BOARDS[0]);
    setLayoutId(null);
    setSizeId(null);
    setSetIds([]);
    setAngle(40);
  };

  // Pre-fill from a seed (e.g. a tapped Popular config). Applied whenever the
  // seed changes so opening the builder from a different config re-fills it.
  useEffect(() => {
    if (!seed) return;
    setBoardName(seed.boardName);
    setLayoutId(seed.layoutId);
    setSizeId(seed.sizeId);
    setSetIds(seed.setIds.split(',').map(Number).filter(Number.isFinite));
    setAngle(seed.angle ?? ((ANGLES[seed.boardName] ?? []).includes(40) ? 40 : (ANGLES[seed.boardName]?.[0] ?? 0)));
  }, [seed]);

  // Cascading option lists — each derives from the selection above it.
  const layouts = useMemo(() => getBoardLayouts(boardName), [boardName]);
  const sizes = useMemo(
    () => (layoutId != null ? getBoardSizesForLayoutId(boardName, layoutId) : []),
    [boardName, layoutId],
  );
  const sets = useMemo(
    () => (layoutId != null && sizeId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId) : []),
    [boardName, layoutId, sizeId],
  );
  const angles = ANGLES[boardName] ?? [];

  // Reset everything below a changed level so the cascade stays consistent.
  const selectBoard = (next: BoardName) => {
    setBoardName(next);
    setLayoutId(null);
    setSizeId(null);
    setSetIds([]);
    setAngle((ANGLES[next] ?? []).includes(40) ? 40 : (ANGLES[next]?.[0] ?? 0));
  };
  const selectLayout = (next: number) => {
    setLayoutId(next);
    const defaultSize = getDefaultBoardSizeForLayout(boardName, next);
    setSizeId(defaultSize);
    setSetIds(defaultSize != null ? getBoardSetsForLayoutAndSize(boardName, next, defaultSize).map((s) => s.id) : []);
  };
  const selectSize = (next: number) => {
    setSizeId(next);
    // Pre-select all sets for the size (the common case).
    setSetIds(layoutId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, next).map((s) => s.id) : []);
  };
  const toggleSet = (id: number) => {
    setSetIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const canCreate =
    layoutId != null && sizeId != null && setIds.length > 0 && (!isAuthenticated || !createBoard.isPending);

  const handleCreate = async () => {
    if (layoutId == null || sizeId == null || setIds.length === 0) return;
    // Store sets in canonical (deduped, numerically sorted) order so a board
    // built by re-ticking sets (which re-appends at the end) matches an existing
    // owned board instead of inserting a near-duplicate.
    const wireSetIds = normaliseSetIds(setIds.join(','));

    // If the user already owns this exact config, the server would reject the
    // create as a duplicate — activate the existing board instead of erroring.
    const owned = findOwnedBoardForConfig(existingBoards, {
      boardType: boardName,
      layoutId,
      sizeId,
      setIds: wireSetIds,
    });
    if (owned) {
      onSelectExisting(owned);
      return;
    }

    const layoutName = layouts.find((l) => l.id === layoutId)?.name ?? boardName;
    const size = sizes.find((s) => s.id === sizeId);
    const selectedSetIds = new Set(wireSetIds.split(','));
    const setNames = sets.filter((set) => selectedSetIds.has(String(set.id))).map((set) => set.name);
    if (!isAuthenticated) {
      onCreated(
        createGuestActiveBoard({
          boardName,
          layoutId,
          sizeId,
          setIds: wireSetIds,
          angle,
          displayName: layoutName,
          layoutName,
          sizeName: size?.name ?? null,
          sizeDescription: size?.description ?? null,
          setNames,
        }),
      );
      return;
    }

    try {
      const board = await createBoard.mutateAsync({
        boardType: boardName,
        layoutId,
        sizeId,
        setIds: wireSetIds,
        name: layoutName,
        angle,
        isOwned: true,
      });
      onCreated(board);
    } catch {
      onError();
    }
  };

  const renderChips = <T,>(
    options: T[],
    getKey: (o: T) => number | string,
    getLabel: (o: T) => string,
    isSelected: (o: T) => boolean,
    onSelect: (o: T) => void,
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {options.map((option) => {
        const selected = isSelected(option);
        return (
          <Pressable
            key={getKey(option)}
            onPress={() => onSelect(option)}
            style={[
              styles.chip,
              {
                // Border is a foreground accent → scheme-aware (lifts in dark).
                borderColor: selected ? themeBrandColors.primary : systemColors.separator,
                // Fill stays static: the selected chip's label turns white and
                // must sit on the saturated brand fill at full contrast.
                backgroundColor: selected ? brandColors.primary : 'transparent',
              },
            ]}
          >
            <Text variant="footnote" color={selected ? iosSystemColors.white : systemColors.label}>
              {getLabel(option)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <Sheet ref={ref} snapPoints={['85%']} onClose={resetForm}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text variant="title3" style={styles.heading}>
          {t('mobile.custom.title')}
        </Text>

        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
          {t('mobile.custom.board')}
        </Text>
        {renderChips(
          SUPPORTED_BOARDS,
          (b) => b,
          (b) => b,
          (b) => b === boardName,
          (b) => selectBoard(b),
        )}

        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
          {t('mobile.custom.layout')}
        </Text>
        {renderChips(
          layouts,
          (l) => l.id,
          (l) => l.name,
          (l) => l.id === layoutId,
          (l) => selectLayout(l.id),
        )}

        {sizes.length > 0 ? (
          <>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
              {t('mobile.custom.size')}
            </Text>
            {renderChips(
              sizes,
              (s) => s.id,
              (s) => s.name,
              (s) => s.id === sizeId,
              (s) => selectSize(s.id),
            )}
          </>
        ) : null}

        {sets.length > 0 ? (
          <>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
              {t('mobile.custom.sets')}
            </Text>
            {renderChips(
              sets,
              (s) => s.id,
              (s) => s.name,
              (s) => setIds.includes(s.id),
              (s) => toggleSet(s.id),
            )}
          </>
        ) : null}

        {angles.length > 0 ? (
          <>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
              {t('mobile.custom.angle')}
            </Text>
            {renderChips(
              angles,
              (a) => a,
              (a) => `${a}°`,
              (a) => a === angle,
              (a) => setAngle(a),
            )}
          </>
        ) : null}

        <Button
          title={t('mobile.custom.start')}
          onPress={() => void handleCreate()}
          variant="filled"
          size="large"
          disabled={!canCreate}
          loading={isAuthenticated && createBoard.isPending}
          style={styles.cta}
        />
      </ScrollView>
    </Sheet>
  );
});

const styles = StyleSheet.create({
  content: {
    padding: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[2],
  },
  heading: {
    marginBottom: spacing[2],
  },
  sectionLabel: {
    marginTop: spacing[3],
    marginBottom: spacing[1],
    textTransform: 'uppercase',
  },
  chipRow: {
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    marginTop: spacing[6],
  },
});
