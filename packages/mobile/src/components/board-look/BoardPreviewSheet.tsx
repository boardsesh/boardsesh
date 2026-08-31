import { StyleSheet, View } from 'react-native';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { BOARD_PREVIEW_RENDER_WIDTH, type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { BoardRenderSettings } from '../../lib/board-render-settings';
import type { HoldColorOverrides } from '../../lib/hold-color-overrides';
import { borderRadius, spacing } from '../../theme/tokens';

type BoardPreviewSheetProps = {
  visible: boolean;
  /** Null while nothing has ever been opened; otherwise the look being shown. */
  title: string | null;
  subtitle?: string;
  /** A caveat under the board, e.g. that only the markers are simulated. */
  note?: string;
  preview: BoardPreviewSource;
  /** Draw under a different settings bundle — how a preset card previews itself. */
  renderSettingsOverride?: BoardRenderSettings;
  /** Draw the four hold roles under a different palette. Must be memoized. */
  holdColorOverride?: HoldColorOverrides;
  /** Identity of what is drawn, so a recycled image does not keep the last one. */
  recyclingKey?: string;
  onClose: () => void;
  onFullyDismissed: () => void;
};

/**
 * A board preview at a size you can actually judge.
 *
 * A 168pt thumbnail is enough to choose between looks at a glance, but not to
 * tell whether two hold colours stay apart or what a glow really does to a
 * crowded wall — so every rail of preview cards can open one full size.
 *
 * Shared by the preset rail and the colour-vision palette rail so the two cannot
 * drift on what enlarging a card means.
 *
 * Passes the SAME `renderWidth` as the thumbnails, so this reuses the render
 * they already paid for rather than minting a second one at a second size.
 */
export function BoardPreviewSheet({
  visible,
  title,
  subtitle,
  note,
  preview,
  renderSettingsOverride,
  holdColorOverride,
  recyclingKey,
  onClose,
  onFullyDismissed,
}: BoardPreviewSheetProps) {
  const { systemColors } = useTheme();

  return (
    <ModalSheet visible={visible} snapPoints={['85%']} onClose={onClose} onFullyDismissed={onFullyDismissed} scrollable>
      {title != null ? (
        <View style={styles.body}>
          <Text variant="headline">{title}</Text>
          {subtitle ? (
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {subtitle}
            </Text>
          ) : null}
          <View style={[styles.board, { backgroundColor: systemColors.tertiaryBackground }]}>
            <BoardImageNative
              frames={preview.frames}
              boardName={preview.boardName}
              layoutId={preview.layoutId}
              sizeId={preview.sizeId}
              setIds={preview.setIds}
              boardWidth={preview.boardWidth}
              boardHeight={preview.boardHeight}
              renderWidth={BOARD_PREVIEW_RENDER_WIDTH}
              renderSettingsOverride={renderSettingsOverride}
              holdColorOverride={holdColorOverride}
              recyclingKey={recyclingKey}
            />
          </View>
          {note ? (
            <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.note}>
              {note}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  board: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginTop: spacing[2],
  },
  note: {
    lineHeight: 18,
  },
});
