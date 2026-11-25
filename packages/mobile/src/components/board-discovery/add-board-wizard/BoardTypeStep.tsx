// "Which board?" in the add-a-board wizard: three big tiles for MoonBoard,
// Kilter and Tension (95% of boards created), each the board's own art at the
// setup Set up will open on, and a list of the other types under "Other
// boards". A tap moves on: there is no Next.
//
// Below 340 pt, or with text over 130%, the three tiles have no room for their
// names ("MoonBoard" has 4 pt to spare at 320 pt), so every type is a row.

import { memo, useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { useTheme } from '../../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../../hooks/use-bottom-chrome-metrics';
import {
  boardTypeArt,
  boardTypeTilesFit,
  splitBoardTypes,
  type BoardTypeArt,
} from '../../../lib/boards/board-type-tiles';
import { cardCorners, spacing } from '../../../theme/tokens';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { ArtRow } from '../../ArtRow';
import { InsetGroupedList } from '../../InsetGroupedList';
import { ShelfHeader, SHELF_HEADER_CONTENT_GAP, SHELF_SECTION_GAP } from '../../ShelfHeader';
import { BoardThumbnail } from '../../boards/BoardThumbnail';
import { boardTypeLabel } from '../board-builder-labels';
import { WizardStepHeader } from './WizardStepHeader';

/** The art's side in a tile, in points. */
const TILE_ART_SIZE = 64;
const GUTTER = spacing[4];
const TILE_GAP = spacing[3];

export type BoardTypeStepProps = {
  stepLabel: string | null;
  /** The popular setups, so each tile draws the setup Set up opens on. Undefined while loading. */
  popularConfigs: readonly PopularBoardConfig[] | undefined;
  onPick: (boardName: BoardName) => void;
};

export function BoardTypeStep({ stepLabel, popularConfigs, onPick }: BoardTypeStepProps) {
  const { t } = useTranslation('boards');
  const bottomChrome = useBottomChromeMetrics();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { featured, others } = useMemo(() => splitBoardTypes(SUPPORTED_BOARDS, boardTypeLabel), []);
  const tilesFit = boardTypeTilesFit(windowWidth, fontScale);
  const tileWidth = Math.floor((windowWidth - GUTTER * 2 - TILE_GAP * (featured.length - 1)) / featured.length);
  const tileTypes = tilesFit ? featured : [];
  const rowTypes = tilesFit ? others : [...featured, ...others];
  // One art object per type per popular list, so the memoised tiles and rows
  // skip a re-render.
  const artByType = useMemo(
    () => new Map(SUPPORTED_BOARDS.map((boardName) => [boardName, boardTypeArt(boardName, popularConfigs)])),
    [popularConfigs],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, { paddingBottom: bottomChrome.scrollBottomPadding }]}
      testID="board-type-step"
    >
      <WizardStepHeader stepLabel={stepLabel} title={t('mobile.addWizard.whichBoard')} />
      {tileTypes.length > 0 ? (
        <View style={styles.tiles} testID="board-type-tiles">
          {tileTypes.map((boardName) => (
            <BoardTypeTile
              key={boardName}
              boardName={boardName}
              art={artByType.get(boardName) ?? null}
              width={tileWidth}
              onPick={onPick}
            />
          ))}
        </View>
      ) : null}
      {rowTypes.length > 0 ? (
        <View style={tileTypes.length > 0 ? styles.otherSection : undefined}>
          {tileTypes.length > 0 ? (
            <View style={styles.otherHeader}>
              <ShelfHeader title={t('mobile.addWizard.otherBoards')} />
            </View>
          ) : null}
          <View style={styles.listGutter}>
            <InsetGroupedList separatorInset="compact" testID="board-type-rows">
              {rowTypes.map((boardName) => (
                <BoardTypeRow
                  key={boardName}
                  boardName={boardName}
                  art={artByType.get(boardName) ?? null}
                  onPick={onPick}
                />
              ))}
            </InsetGroupedList>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** One big tile: the board's art on the tile's own fill, its name under it. */
const BoardTypeTile = memo(function BoardTypeTile({
  boardName,
  art,
  width,
  onPick,
}: {
  boardName: BoardName;
  art: BoardTypeArt | null;
  width: number;
  onPick: (boardName: BoardName) => void;
}) {
  const { systemColors } = useTheme();
  const label = boardTypeLabel(boardName);
  const handlePress = useCallback(() => onPick(boardName), [onPick, boardName]);
  const tileStyle = useMemo(
    () => [styles.tile, { width, backgroundColor: systemColors.secondaryBackground }],
    [width, systemColors.secondaryBackground],
  );
  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      rippleColor={systemColors.label as string}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={tileStyle}
      testID={`board-type-tile-${boardName}`}
    >
      <ThumbnailOrNothing art={art} size={TILE_ART_SIZE} />
      <Text variant="subheadline" emphasized style={styles.tileLabel}>
        {label}
      </Text>
    </PressableSurface>
  );
});

/** One of the other types: compact art, the name, a chevron. */
const BoardTypeRow = memo(function BoardTypeRow({
  boardName,
  art,
  onPick,
}: {
  boardName: BoardName;
  art: BoardTypeArt | null;
  onPick: (boardName: BoardName) => void;
}) {
  const handlePress = useCallback(() => onPick(boardName), [onPick, boardName]);
  const artElement = useMemo(() => <ThumbnailOrNothing art={art} size="compact" />, [art]);
  return (
    <ArtRow
      art={artElement}
      artSize="compact"
      title={boardTypeLabel(boardName)}
      titleVariant="body"
      accessory="chevron"
      onPress={handlePress}
      testID={`board-type-row-${boardName}`}
    />
  );
});

function ThumbnailOrNothing({ art, size }: { art: BoardTypeArt | null; size: number | 'compact' }) {
  const board = useMemo(
    () => (art ? { boardType: art.boardType, layoutId: art.layoutId, sizeId: art.sizeId, setIds: art.setIds } : null),
    [art],
  );
  if (!board) return <BoardThumbnail board={EMPTY_BOARD} size={size} />;
  return <BoardThumbnail board={board} size={size} />;
}

/** A board the catalogue can't draw: the thumbnail's own placeholder glyph. */
const EMPTY_BOARD = { boardType: '', layoutId: 0, sizeId: 0, setIds: '' };

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[4],
    gap: spacing[5],
  },
  tiles: {
    flexDirection: 'row',
    paddingHorizontal: GUTTER,
    gap: TILE_GAP,
  },
  tile: {
    ...cardCorners,
    alignItems: 'center',
    paddingTop: spacing[3],
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[3],
    minHeight: 124,
    gap: spacing[2],
  },
  tileLabel: {
    textAlign: 'center',
  },
  otherSection: {
    marginTop: SHELF_SECTION_GAP - spacing[5],
  },
  otherHeader: {
    paddingBottom: SHELF_HEADER_CONTENT_GAP,
  },
  listGutter: {
    paddingHorizontal: GUTTER,
  },
});
