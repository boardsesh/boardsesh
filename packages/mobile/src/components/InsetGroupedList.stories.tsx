import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StoryModule, StoryRenderControls } from '../dev/stories/types';
import { STORY_BOARDS } from '../dev/fixtures/boards';
import { StoryPage, StoryPageLabel, useStoryArtReadiness } from '../dev/stories/StoryPage';
import type { BoardArtReadiness } from '../lib/board-render/ready-board-art';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { ArtRow } from './ArtRow';
import { Icon } from './Icon';
import { InsetGroupedList, insetGroupedRowStyles } from './InsetGroupedList';
import { PressableSurface } from './PressableSurface';
import { StatusPill } from './StatusPill';
import { Text } from './Text';
import { BoardThumbnail, BoardThumbnailView } from './boards/BoardThumbnail';
import { PlaylistPreviewSquare } from './playlist/PlaylistPreviewSquare';

const noop = () => {};

function RowStates() {
  const { systemColors } = useTheme();
  const [selectedKey, setSelectedKey] = useState('kilter');
  const selectKilter = useCallback(() => setSelectedKey('kilter'), []);
  const selectTension = useCallback(() => setSelectedKey('tension'), []);
  const selectMoon = useCallback(() => setSelectedKey('moonboard'), []);
  const boardGlyph = <Icon name="boards" size={22} color={systemColors.secondaryLabel} />;
  return (
    <StoryPage ground="grouped">
      <StoryPageLabel>Navigation rows</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          <ArtRow
            art={<PlaylistPreviewSquare color="#E11D48" icon="❤️" size={44} />}
            artSize="regular"
            title="Liked climbs"
            subtitle="128 climbs"
            accessory="chevron"
            onPress={noop}
          />
          <ArtRow
            art={<PlaylistPreviewSquare color="#2563EB" icon="🎯" size={44} />}
            artSize="regular"
            title="Projects"
            accessory="chevron"
            onPress={noop}
          />
          <View style={insetGroupedRowStyles.row}>
            <View style={insetGroupedRowStyles.leading}>
              <Icon name="discover" size={20} color={systemColors.secondaryLabel} />
            </View>
            <Text variant="body" style={insetGroupedRowStyles.text}>
              All playlists
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </View>
        </InsetGroupedList>
      </View>

      <StoryPageLabel>A choice: selected row, checkmark</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Garage Board"
            subtitle="Kilter · 40°"
            accessory="checkmark"
            selected={selectedKey === 'kilter'}
            onPress={selectKilter}
          />
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Club wall"
            subtitle="Tension · 7 x 10"
            accessory="checkmark"
            selected={selectedKey === 'tension'}
            onPress={selectTension}
          />
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="MoonBoard 2024"
            subtitle="MoonBoard · 40°"
            accessory="checkmark"
            selected={selectedKey === 'moonboard'}
            onPress={selectMoon}
          />
        </InsetGroupedList>
      </View>

      <StoryPageLabel>Eyebrow, status, long title</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            eyebrow="Session running"
            title="Garage Board"
            subtitle="Kilter · 12 x 12 · 40°"
            accessory="chevron"
            onPress={noop}
          />
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Bergen Klatresenter Danmarksplass Kilter Original"
            subtitle="Kilter · 12 x 12"
            status={<StatusPill label="Closest" />}
            accessory="chevron"
            onPress={noop}
          />
          <ArtRow art={boardGlyph} artSize="regular" title="A static row" subtitle="No press handler" />
        </InsetGroupedList>
      </View>

      <StoryPageLabel>A control at the end, selected and not</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Garage Board"
            subtitle="Kilter · 40°"
            accessory={
              <PressableSurface onPress={noop} feedback="opacity" hitSlop={12} accessibilityLabel="Board actions">
                <Icon name="more" size={20} color={systemColors.accent} />
              </PressableSurface>
            }
            selected
            onPress={noop}
            onLongPress={noop}
            longPressAccessibilityLabel="Board actions"
          />
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Club wall"
            subtitle="Tension · 7 x 10"
            accessory={
              <PressableSurface onPress={noop} feedback="opacity" hitSlop={12} accessibilityLabel="Board actions">
                <Icon name="more" size={20} color={systemColors.accent} />
              </PressableSurface>
            }
            onPress={noop}
          />
        </InsetGroupedList>
      </View>

      <StoryPageLabel>Compact</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList separatorInset="compact">
          <ArtRow
            art={<BoardThumbnailView size="compact" aspectRatio={null} placeholder="camera" art={null} />}
            artSize="compact"
            title="Spray wall"
            subtitle="Photo still downloading"
            accessory="chevron"
            onPress={noop}
          />
          <ArtRow
            art={<BoardThumbnailView size="compact" aspectRatio={null} placeholder="boards" art={null} />}
            artSize="compact"
            title="Unknown board"
            subtitle="No art for this layout"
            accessory="chevron"
            onPress={noop}
          />
        </InsetGroupedList>
      </View>
    </StoryPage>
  );
}

const BOARD_ROWS = [
  { key: 'kilter', fixture: 'kilter-original-12x12', title: 'Garage Board', subtitle: 'Kilter · 12 x 12 · 40°' },
  { key: 'homewall', fixture: 'kilter-homewall-7x10', title: 'Crux Homewall', subtitle: 'Kilter · 7 x 10' },
  { key: 'tension', fixture: 'tension-2-mirror', title: 'Club wall', subtitle: 'Tension · 12 x 12' },
  { key: 'moonboard', fixture: 'moonboard-2024', title: 'MoonBoard 2024', subtitle: 'MoonBoard · 40°' },
] as const;

function StoryBoardRow({
  row,
  selected,
  closest,
  onDisplayed,
  onError,
}: {
  row: (typeof BOARD_ROWS)[number];
  selected: boolean;
  closest: boolean;
  onDisplayed: (key: string) => void;
  onError: (error: unknown) => void;
}) {
  const { board } = STORY_BOARDS[row.fixture];
  const thumbnailBoard = useMemo(
    () => ({ boardType: board.boardName, layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds }),
    [board],
  );
  const onArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      if (readiness === 'ready') onDisplayed(row.key);
      if (readiness === 'failed') onError(new Error(`Board art failed for ${row.fixture}`));
    },
    [onDisplayed, onError, row.key, row.fixture],
  );
  return (
    <ArtRow
      art={<BoardThumbnail board={thumbnailBoard} size="regular" onArtReadinessChange={onArtReadinessChange} />}
      artSize="regular"
      title={row.title}
      subtitle={row.subtitle}
      status={closest ? <StatusPill label="Closest" /> : undefined}
      accessory="checkmark"
      selected={selected}
      onPress={noop}
    />
  );
}

const BOARD_ART_KEYS = BOARD_ROWS.map((row) => row.key);

function BoardRows({ onReady, onError }: StoryRenderControls) {
  const onDisplayed = useStoryArtReadiness(BOARD_ART_KEYS, onReady);
  return (
    <StoryPage ground="grouped">
      <StoryPageLabel>Your boards</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          {BOARD_ROWS.map((row, index) => (
            <StoryBoardRow
              key={row.key}
              row={row}
              selected={index === 0}
              closest={index === 1}
              onDisplayed={onDisplayed}
              onError={onError}
            />
          ))}
          <ArtRow
            art={<BoardThumbnailView size="regular" aspectRatio={null} placeholder="camera" art={null} />}
            artSize="regular"
            title="Garage spray wall"
            subtitle="Spray wall"
            accessory="checkmark"
            onPress={noop}
          />
        </InsetGroupedList>
      </View>
    </StoryPage>
  );
}

const styles = StyleSheet.create({
  inset: {
    paddingHorizontal: spacing[4],
  },
});

const stories: StoryModule = {
  title: 'Velvet / Inset grouped list',
  stories: {
    rows: { name: 'Art rows', layout: 'fullscreen', render: () => <RowStates /> },
    boards: {
      name: 'Board rows',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <BoardRows {...controls} />,
    },
  },
};
export default stories;
