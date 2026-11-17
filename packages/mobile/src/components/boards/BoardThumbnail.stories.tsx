import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { STORY_BOARDS } from '../../dev/fixtures/boards';
import { StoryPage, StoryPageLabel, useStoryArtReadiness } from '../../dev/stories/StoryPage';
import { StorySprayBoard } from '../../dev/stories/StorySprayBoard';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { spacing } from '../../theme/tokens';
import { Text } from '../Text';
import { BoardThumbnail, BoardThumbnailView, type BoardThumbnailSize } from './BoardThumbnail';

const SIZES: readonly BoardThumbnailSize[] = ['compact', 'regular', 96];
const CATALOGUE_BOARDS = [
  { fixture: 'kilter-original-12x12', label: 'Kilter Original 12 x 12' },
  { fixture: 'kilter-homewall-7x10', label: 'Kilter Homewall 7 x 10' },
  { fixture: 'tension-2-mirror', label: 'Tension 2 Mirror' },
  { fixture: 'moonboard-2024', label: 'MoonBoard 2024' },
] as const;
const SPRAY_FIXTURE = 'spray-liz';

function artKey(fixture: string, size: BoardThumbnailSize): string {
  return `${fixture}:${size}`;
}

const EXPECTED_ART = [
  ...CATALOGUE_BOARDS.flatMap((board) => SIZES.map((size) => artKey(board.fixture, size))),
  ...SIZES.map((size) => artKey(SPRAY_FIXTURE, size)),
];

function CatalogueThumbnail({
  fixture,
  size,
  onDisplayed,
  onError,
}: {
  fixture: string;
  size: BoardThumbnailSize;
  onDisplayed: (key: string) => void;
  onError: (error: unknown) => void;
}) {
  const { board } = STORY_BOARDS[fixture];
  const thumbnailBoard = useMemo(
    () => ({ boardType: board.boardName, layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds }),
    [board],
  );
  const onArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      if (readiness === 'ready') onDisplayed(artKey(fixture, size));
      if (readiness === 'failed') onError(new Error(`Board art failed for ${fixture}`));
    },
    [fixture, size, onDisplayed, onError],
  );
  return <BoardThumbnail board={thumbnailBoard} size={size} onArtReadinessChange={onArtReadinessChange} />;
}

/** A spray wall whose photo is on disk: the live registry isn't loaded in a story, so the art comes in directly. */
function SprayPhotoThumbnail({
  size,
  onDisplayed,
  onError,
}: {
  size: BoardThumbnailSize;
  onDisplayed: (key: string) => void;
  onError: (error: unknown) => void;
}) {
  const geometry = STORY_BOARDS[SPRAY_FIXTURE].spray;
  const onReady = useCallback(() => onDisplayed(artKey(SPRAY_FIXTURE, size)), [onDisplayed, size]);
  if (!geometry) throw new Error('The spray story fixture has no geometry');
  return (
    <BoardThumbnailView
      size={size}
      aspectRatio={geometry.width / geometry.height}
      placeholder="camera"
      art={<StorySprayBoard geometry={geometry} frames="" onReady={onReady} onError={onError} />}
    />
  );
}

function ThumbnailGrid({ onReady, onError }: StoryRenderControls) {
  const onDisplayed = useStoryArtReadiness(EXPECTED_ART, onReady);
  return (
    <StoryPage ground="plain">
      {CATALOGUE_BOARDS.map((board) => (
        <View key={board.fixture}>
          <StoryPageLabel>{board.label}</StoryPageLabel>
          <View style={styles.row}>
            {SIZES.map((size) => (
              <CatalogueThumbnail
                key={String(size)}
                fixture={board.fixture}
                size={size}
                onDisplayed={onDisplayed}
                onError={onError}
              />
            ))}
          </View>
        </View>
      ))}
      <StoryPageLabel>Spray wall, photo on disk</StoryPageLabel>
      <View style={styles.row}>
        {SIZES.map((size) => (
          <SprayPhotoThumbnail key={String(size)} size={size} onDisplayed={onDisplayed} onError={onError} />
        ))}
      </View>
      <StoryPageLabel>Spray wall, photo not on disk yet</StoryPageLabel>
      <View style={styles.row}>
        {SIZES.map((size) => (
          <BoardThumbnailView key={String(size)} size={size} aspectRatio={null} placeholder="camera" art={null} />
        ))}
      </View>
      <StoryPageLabel>A board the catalogue can't draw</StoryPageLabel>
      <View style={styles.row}>
        {SIZES.map((size) => (
          <BoardThumbnailView key={String(size)} size={size} aspectRatio={null} placeholder="boards" art={null} />
        ))}
      </View>
      <View style={styles.legend}>
        <Text variant="footnote" tone="secondary">
          Compact 36×44, regular 44×56, then a 96pt square. Each board keeps its own shape inside the slot.
        </Text>
      </View>
    </StoryPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  legend: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});

const stories: StoryModule = {
  title: 'Velvet / Board thumbnail',
  stories: {
    sizes: {
      name: 'Sizes and fallbacks',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <ThumbnailGrid {...controls} />,
    },
  },
};
export default stories;
