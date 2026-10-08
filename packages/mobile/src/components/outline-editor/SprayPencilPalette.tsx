import { PressableSurface } from '../PressableSurface';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '../GlassIconButton';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { PENCIL_PALETTE_BUTTON_SIZE, pencilPaletteOffsets } from './pencil-palette-layout';
import type { SprayEditorTool } from './spray-edit-tap';
import type { SprayAddShape } from './use-spray-add-shape';

type SprayPencilPaletteProps = {
  /** The ring's centre, in the editor's coordinates (`pencilPaletteCentre`). */
  centre: { x: number; y: number };
  tool: SprayEditorTool;
  addShape: SprayAddShape;
  canUndo: boolean;
  canRedo: boolean;
  onMark: () => void;
  onDraw: () => void;
  onCorners: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** A tap anywhere off the buttons, or a button that has done its job. */
  onClose: () => void;
};

type PaletteItem = {
  key: string;
  iconName: IconName;
  label: string;
  current: boolean;
  disabled: boolean;
  onPress: () => void;
};

/**
 * The Apple Pencil squeeze palette (Pencil Pro): the editor's tools in a ring
 * round the Pencil tip, so switching tools never sends the hand to the rail.
 * Mark, Draw, Corners, then Undo and Redo, clockwise from the top. The tool in
 * use is drawn in the accent colour. Choosing one closes the palette, and so
 * does a tap anywhere else.
 */
export const SprayPencilPalette = React.memo(function SprayPencilPalette({
  centre,
  tool,
  addShape,
  canUndo,
  canRedo,
  onMark,
  onDraw,
  onCorners,
  onUndo,
  onRedo,
  onClose,
}: SprayPencilPaletteProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const items: PaletteItem[] = [
    {
      key: 'mark',
      iconName: 'hand.tap',
      label: t('sprayEditor.rail.mark'),
      current: tool !== 'add',
      disabled: false,
      onPress: onMark,
    },
    {
      key: 'draw',
      iconName: 'shape.draw',
      label: t('sprayEditor.palette.draw'),
      current: tool === 'add' && addShape === 'draw',
      disabled: false,
      onPress: onDraw,
    },
    {
      key: 'corners',
      iconName: 'shape.corners',
      label: t('sprayEditor.palette.corners'),
      current: tool === 'add' && addShape === 'corners',
      disabled: false,
      onPress: onCorners,
    },
    {
      key: 'undo',
      iconName: 'undo',
      label: t('sprayEditor.bar.undo'),
      current: false,
      disabled: !canUndo,
      onPress: onUndo,
    },
    {
      key: 'redo',
      iconName: 'redo',
      label: t('sprayEditor.bar.redo'),
      current: false,
      disabled: !canRedo,
      onPress: onRedo,
    },
  ];
  const offsets = pencilPaletteOffsets(items.length);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal>
      <PressableSurface
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('sprayEditor.palette.close')}
      />
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
        accessibilityRole="toolbar"
        accessibilityLabel={t('sprayEditor.palette.label')}
      >
        {items.map((item, index) => (
          <View
            key={item.key}
            style={[
              styles.slot,
              {
                left: centre.x + offsets[index].dx - PENCIL_PALETTE_BUTTON_SIZE / 2,
                top: centre.y + offsets[index].dy - PENCIL_PALETTE_BUTTON_SIZE / 2,
              },
            ]}
          >
            <GlassIconButton
              iconName={item.iconName}
              iconColor={item.current ? brandColors.primary : systemColors.label}
              fallbackColor={systemColors.fill}
              size={PENCIL_PALETTE_BUTTON_SIZE}
              disabled={item.disabled}
              accessibilityLabel={item.label}
              onPress={() => {
                item.onPress();
                onClose();
              }}
            />
          </View>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    position: 'absolute',
    width: PENCIL_PALETTE_BUTTON_SIZE,
    height: PENCIL_PALETTE_BUTTON_SIZE,
  },
});
