import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { springs } from '../../theme/animations';
import { spacing } from '../../theme/tokens';
import {
  railDockX,
  SPRAY_RAIL_BUTTON_SIZE,
  SPRAY_RAIL_PADDING,
  SPRAY_RAIL_WIDTH,
  type SprayRailSide,
} from './spray-tablet-layout';

/** A rail glyph, the size `GlassIconButton` draws its own. */
const RAIL_ICON_SIZE = 22;
/** The grip is a short handle, not a full button: it is dragged, not aimed at. */
const GRIP_HEIGHT = 28;
/** Dimmed opacity for a button that cannot act right now. */
const DISABLED_OPACITY = 0.4;
/** How far the grip moves before the drag takes it, so a tap on it stays a tap. */
const GRIP_DRAG_SLOP_PT = 6;

type SprayToolRailProps = {
  side: SprayRailSide;
  /** The rail was dragged across, or its grip was activated by a screen reader. */
  onSideChange: (side: SprayRailSide) => void;
  windowWidth: number;
  leftInset: number;
  rightInset: number;
  /** Read-only, a commit in flight, or the reveal still running: every button is disabled. */
  locked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Add mode is on. Otherwise the resting pick-and-switch tool (Mark) is. */
  adding: boolean;
  /** Back to the resting tool: leaves Add, or cancels Trace or Join. */
  onMark: () => void;
  /** Enter Add mode, or leave it while `adding`. */
  onAdd: () => void;
  /** The wall has maybes and this target reviews them: show the two maybe buttons. */
  maybeControls: boolean;
  showMaybes: boolean;
  onToggleMaybes: () => void;
  onKeepMaybes: () => void;
  /** A Pencil has been seen (or chosen before): show the Pencil only toggle. */
  pencilToggleAvailable: boolean;
  pencilOnly: boolean;
  onTogglePencilOnly: () => void;
  /** Fit the whole wall back on screen (the zoom reset). */
  onFit: () => void;
  /** The wall-wide menu (Start over). */
  onMore: () => void;
  moreExpanded: boolean;
  /** Replays the hints. Omitted hides the "?" (screenshot mode). */
  onHelp?: () => void;
};

/**
 * The iPad editor's tools, in one vertical glass capsule docked to the side of
 * the screen: Undo and Redo, the two tools (Mark, the resting pick-and-switch,
 * and Add), the maybes' show-or-hide and keep-all, "Pencil only" once a Pencil
 * has been seen, fit-the-wall, the wall-wide menu and the hints. It is the
 * phone's bottom bar turned on its side, minus the counts and the primary
 * button, which keep a cluster of their own at the bottom.
 *
 * Down the side rather than along the bottom because on a big screen the
 * bottom edge is a long way from both hands, and the Pencil hand rests on it.
 * Which side is the climber's: dragging the grip past the middle of the screen
 * springs the rail to the other edge, and the choice is kept per device
 * (`useSprayRailSide`). A screen reader activates the grip instead.
 *
 * The drag runs on the UI thread: the rail's position is a shared value, the
 * snap rule is `railSideAfterDrag`'s arithmetic inlined in the worklet, and JS
 * hears once, when the side changes.
 */
export const SprayToolRail = React.memo(function SprayToolRail({
  side,
  onSideChange,
  windowWidth,
  leftInset,
  rightInset,
  locked,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  adding,
  onMark,
  onAdd,
  maybeControls,
  showMaybes,
  onToggleMaybes,
  onKeepMaybes,
  pencilToggleAvailable,
  pencilOnly,
  onTogglePencilOnly,
  onFit,
  onMore,
  moreExpanded,
  onHelp,
}: SprayToolRailProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const leadingX = railDockX({ side: 'leading', windowWidth, leftInset, rightInset });
  const trailingX = railDockX({ side: 'trailing', windowWidth, leftInset, rightInset });
  const dockX = side === 'leading' ? leadingX : trailingX;

  // Mirrored for the worklet: the two docks, the middle, and the side.
  const leadingXSV = useSharedValue(leadingX);
  const trailingXSV = useSharedValue(trailingX);
  const middleXSV = useSharedValue(windowWidth / 2);
  const isLeadingSV = useSharedValue(side === 'leading');
  /** The rail's left edge, at rest or springing. */
  const positionXSV = useSharedValue(dockX);
  const dragXSV = useSharedValue(0);
  /** A let-go spring is carrying the rail to its dock; a re-render must not cut it short. */
  const springingSV = useSharedValue(false);

  useEffect(() => {
    leadingXSV.value = leadingX;
    trailingXSV.value = trailingX;
    middleXSV.value = windowWidth / 2;
    isLeadingSV.value = side === 'leading';
    if (!springingSV.value) positionXSV.value = dockX;
  }, [
    leadingX,
    trailingX,
    windowWidth,
    side,
    dockX,
    leadingXSV,
    trailingXSV,
    middleXSV,
    isLeadingSV,
    positionXSV,
    springingSV,
  ]);

  const onSideChangeRef = useRef(onSideChange);
  onSideChangeRef.current = onSideChange;
  const handleSideChange = (next: SprayRailSide) => onSideChangeRef.current(next);

  const grip = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-GRIP_DRAG_SLOP_PT, GRIP_DRAG_SLOP_PT])
        .onUpdate((event) => {
          'worklet';
          dragXSV.value = event.translationX;
        })
        .onEnd((event) => {
          'worklet';
          const position = positionXSV.value + event.translationX;
          const leading = position + SPRAY_RAIL_WIDTH / 2 < middleXSV.value;
          // Hand the drag over to the spring in the same frame, so the rail
          // does not jump back before it travels.
          positionXSV.value = position;
          dragXSV.value = 0;
          springingSV.value = true;
          positionXSV.value = withSpring(leading ? leadingXSV.value : trailingXSV.value, springs.snappy, () => {
            springingSV.value = false;
          });
          if (leading !== isLeadingSV.value) {
            isLeadingSV.value = leading;
            runOnJS(handleSideChange)(leading ? 'leading' : 'trailing');
          }
        })
        .onFinalize(() => {
          'worklet';
          dragXSV.value = 0;
        }),
    // handleSideChange is intentionally not a dep — it reads the ref.
    [dragXSV, positionXSV, middleXSV, leadingXSV, trailingXSV, isLeadingSV, springingSV],
  );

  const positionStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: positionXSV.value + dragXSV.value }],
  }));

  const label = systemColors.label;
  const accent = brandColors.primary;
  return (
    <View pointerEvents="box-none" style={styles.track}>
      <Animated.View
        style={[styles.rail, positionStyle]}
        accessibilityRole="toolbar"
        accessibilityLabel={t('sprayEditor.rail.label')}
      >
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.fill}
          borderRadius={SPRAY_RAIL_WIDTH / 2}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <GestureDetector gesture={grip}>
          <PressableSurface
            onPress={() => onSideChange(side === 'leading' ? 'trailing' : 'leading')}
            accessibilityRole="button"
            accessibilityLabel={t('sprayEditor.rail.grip')}
            style={styles.grip}
          >
            <Icon name="drag.handle" size={RAIL_ICON_SIZE - 4} color={systemColors.secondaryLabel} />
          </PressableSurface>
        </GestureDetector>

        <RailButton
          iconName="undo"
          label={t('sprayEditor.bar.undo')}
          color={label}
          disabled={locked || !canUndo}
          onPress={onUndo}
        />
        <RailButton
          iconName="redo"
          label={t('sprayEditor.bar.redo')}
          color={label}
          disabled={locked || !canRedo}
          onPress={onRedo}
        />
        <RailDivider color={systemColors.separator} />
        <RailButton
          iconName="hand.tap"
          label={t('sprayEditor.rail.mark')}
          color={adding ? label : accent}
          selected={!adding}
          selectedColor={systemColors.fill}
          disabled={locked}
          onPress={onMark}
        />
        <RailButton
          iconName="plus"
          label={t('sprayEditor.bar.addA11y')}
          color={adding ? accent : label}
          selected={adding}
          selectedColor={systemColors.fill}
          disabled={locked}
          onPress={onAdd}
        />
        {maybeControls ? (
          <>
            <RailDivider color={systemColors.separator} />
            <RailButton
              iconName={showMaybes ? 'visibility.off' : 'visibility'}
              label={showMaybes ? t('sprayEditor.menu.hideMaybes') : t('sprayEditor.menu.showMaybes')}
              color={label}
              disabled={locked}
              onPress={onToggleMaybes}
            />
            {showMaybes ? (
              <RailButton
                iconName="tick.outline"
                label={t('sprayEditor.menu.keepMaybes')}
                color={label}
                disabled={locked}
                onPress={onKeepMaybes}
              />
            ) : null}
          </>
        ) : null}
        <RailDivider color={systemColors.separator} />
        {pencilToggleAvailable ? (
          <RailButton
            iconName="pencil.tip"
            label={t('sprayEditor.rail.pencilOnly')}
            hint={t('sprayEditor.rail.pencilOnlyHint')}
            color={pencilOnly ? accent : label}
            selected={pencilOnly}
            selectedColor={systemColors.fill}
            isSwitch
            disabled={locked}
            onPress={onTogglePencilOnly}
          />
        ) : null}
        <RailButton iconName="fit.screen" label={t('sprayEditor.rail.fit')} color={label} onPress={onFit} />
        <RailButton
          iconName="more.actions"
          label={t('sprayEditor.rail.more')}
          color={moreExpanded ? accent : label}
          selected={moreExpanded}
          selectedColor={systemColors.fill}
          disabled={locked}
          onPress={onMore}
        />
        {onHelp ? (
          <RailButton
            iconName="help"
            label={t('sprayEditor.hints.replay')}
            color={label}
            disabled={locked}
            onPress={onHelp}
          />
        ) : null}
      </Animated.View>
    </View>
  );
});

type RailButtonProps = {
  iconName: IconName;
  label: string;
  hint?: string;
  color: ColorValue;
  /** Drawn on a tinted square: the tool in use, or a toggle that is on. */
  selected?: boolean;
  selectedColor?: ColorValue;
  /** A toggle, read as a switch rather than a tool. */
  isSwitch?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

/** One 48 pt square on the rail. */
const RailButton = React.memo(function RailButton({
  iconName,
  label,
  hint,
  color,
  selected = false,
  selectedColor,
  isSwitch = false,
  disabled = false,
  onPress,
}: RailButtonProps) {
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="scale"
      accessibilityRole={isSwitch ? 'switch' : 'button'}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={isSwitch ? { checked: selected, disabled } : { selected, disabled }}
      style={[
        styles.button,
        selected && selectedColor ? { backgroundColor: selectedColor } : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Icon name={iconName} size={RAIL_ICON_SIZE} color={color} />
    </PressableSurface>
  );
});

function RailDivider({ color }: { color: ColorValue }) {
  return <View style={[styles.divider, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  // The full height of the screen, so the rail centres itself vertically; it
  // takes no touches of its own.
  track: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  rail: {
    width: SPRAY_RAIL_WIDTH,
    padding: SPRAY_RAIL_PADDING,
    borderRadius: SPRAY_RAIL_WIDTH / 2,
    overflow: 'hidden',
    alignItems: 'center',
    gap: spacing[1] / 2,
  },
  grip: {
    width: SPRAY_RAIL_BUTTON_SIZE,
    height: GRIP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: SPRAY_RAIL_BUTTON_SIZE,
    height: SPRAY_RAIL_BUTTON_SIZE,
    borderRadius: SPRAY_RAIL_BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  divider: {
    width: SPRAY_RAIL_BUTTON_SIZE / 2,
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing[1] / 2,
  },
});
