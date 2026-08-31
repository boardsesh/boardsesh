import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HoldOutlineKind } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { Stepper } from '../Stepper';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { OUTLINE_EDITOR_COLORS } from './OutlineSvgLayer';

// Admin-only screen: every string below is a hardcoded English literal, the same
// convention the tester-only Feature Flags / Offline Writes screens follow. No
// catalog keys, so `check:i18n:orphans` has nothing to chase.

/** How the next stroke changes the outline. */
export type DrawMode = 'redraw' | 'add' | 'erase';

// i18n-ignore-next-line — admin-only screen
const KIND_OPTIONS: { key: HoldOutlineKind; label: string }[] = [
  { key: 'SILHOUETTE', label: 'Outer edge' },
  { key: 'LED_INNER', label: 'Inner edge' },
];

// i18n-ignore-next-line — admin-only screen
const DRAW_MODE_OPTIONS: { key: DrawMode; label: string }[] = [
  { key: 'redraw', label: 'Redraw' },
  { key: 'add', label: 'Add' },
  { key: 'erase', label: 'Erase' },
];

// A hold with no outline yet has nothing to add to or erase from, so the control
// collapses to its one usable option rather than dimming two dead segments.
const REDRAW_ONLY_OPTIONS = DRAW_MODE_OPTIONS.slice(0, 1);

// i18n-ignore-next-line — admin-only screen
const BOUNDARY_EXPLAINER =
  'Outer edge traces hold + LED plate; inner edge is where the plate stops. The board lights the ring between them.';

// i18n-ignore-next-line — admin-only screen
const NO_OUTLINE_EXPLAINER =
  'This hold has no outline yet, so trace it once first. Add and erase then work on what you traced.';

// i18n-ignore-next-line — admin-only screen
const BRUSH_SIZE_EXPLAINER = 'Radius in board pixels, so the painted width stays put as you zoom.';

type EditToolbarProps = {
  editKind: HoldOutlineKind;
  onEditKindChange: (kind: HoldOutlineKind) => void;
  /** Whether this board config has an LED base plate behind its holds. Most
   *  boards don't, and offering a second boundary there asks someone to trace a
   *  polygon with nothing on the other side of it — so on those the control is
   *  not rendered at all and the caller pins `editKind` to SILHOUETTE. */
  hasLedBasePlate: boolean;
  /** One line saying what the selected placement currently carries. */
  statusLine: string;
  /** "14 / 499" — how far through the board this placement sits, or null with
   *  nothing selected. Rendered beside the step buttons it belongs to. */
  positionLabel: string | null;
  onNextPlacement: () => void;
  onPreviousPlacement: () => void;
  /** False only on a config with no placements at all. */
  canStepPlacement: boolean;
  /** Last failure to surface — a rejected stroke or a server error. */
  errorText: string | null;
  /** A finished stroke is waiting to be stored. */
  hasDraft: boolean;
  /** At least one stroke on this hold can be stepped back. */
  canUndo: boolean;
  onUndo: () => void;
  onSave: () => void;
  onDiscardDraft: () => void;
  /** A stored override of the current kind exists for the selected placement. */
  hasOverride: boolean;
  onRevert: () => void;
  /** True while a placement is selected — while it is, the pencil draws instead
   *  of selecting, so the toolbar has to offer a way back to picking. */
  hasSelection: boolean;
  onDeselect: () => void;
  saving: boolean;
  fingerDraw: boolean;
  onFingerDrawChange: (next: boolean) => void;
  drawMode: DrawMode;
  onDrawModeChange: (mode: DrawMode) => void;
  /** False when the selected hold carries no outline of the current kind, so
   *  there is nothing for a brush stroke to add to or erase from. */
  canBrush: boolean;
  /** Brush radius in board px, so the painted width holds still as the board is
   *  zoomed. Only meaningful while `drawMode` is add or erase. */
  brushRadiusBoardPx: number;
  onBrushRadiusChange: (radius: number) => void;
  brushRadiusRange: { min: number; max: number };
  /** Draw the selected hold's boundary on top of its wash. */
  showSelectedOutline: boolean;
  onShowSelectedOutlineChange: (next: boolean) => void;
  /** Wash alpha as a WHOLE PERCENT, so the stepper can move it in units a person
   *  can aim at. The layer takes 0-1; the screen divides. */
  washOpacityPercent: number;
  onWashOpacityPercentChange: (percent: number) => void;
  washOpacityRange: { min: number; max: number };
  previewLit: boolean;
  onPreviewLitChange: (next: boolean) => void;
  previewAvailable: boolean;
  /** Why the lit preview can't run right now, or null when it can. Rendered
   *  under the row whenever it is set, so a disabled switch is never mute. */
  previewUnavailableNote: string | null;
  /** Where the toolbar is mounted. Portrait hangs it under the board at full
   *  width ('stacked'); landscape parks it in a ~320pt right rail ('rail'),
   *  where a wrapping button row degenerates into ragged one-per-line anyway,
   *  so the actions stack deliberately instead. */
  layout?: 'stacked' | 'rail';
};

/**
 * The editor's whole control surface: which boundary is being drawn, how the next
 * stroke changes it, what the selected placement carries today, and the three
 * writes (store this stroke, throw it away, drop the stored override).
 */
export const EditToolbar = React.memo(function EditToolbar({
  editKind,
  onEditKindChange,
  hasLedBasePlate,
  statusLine,
  positionLabel,
  onNextPlacement,
  onPreviousPlacement,
  canStepPlacement,
  errorText,
  hasDraft,
  canUndo,
  onUndo,
  onSave,
  onDiscardDraft,
  hasOverride,
  onRevert,
  hasSelection,
  onDeselect,
  saving,
  fingerDraw,
  onFingerDrawChange,
  drawMode,
  onDrawModeChange,
  canBrush,
  brushRadiusBoardPx,
  onBrushRadiusChange,
  brushRadiusRange,
  showSelectedOutline,
  onShowSelectedOutlineChange,
  washOpacityPercent,
  onWashOpacityPercentChange,
  washOpacityRange,
  previewLit,
  onPreviewLitChange,
  previewAvailable,
  previewUnavailableNote,
  layout = 'stacked',
}: EditToolbarProps) {
  const { systemColors } = useTheme();
  const isRail = layout === 'rail';

  // Reverting a LED_INNER row removes an annotation; there is no traced version
  // to fall back to, so the label has to say something different.
  const revertLabel = editKind === 'LED_INNER' ? 'Remove inner edge' : 'Revert to traced';

  const revertNote = useMemo(() => {
    if (!hasOverride) return null;
    return editKind === 'LED_INNER'
      ? // i18n-ignore-next-line — admin-only screen
        "Removing the annotation deletes the row immediately. The renderer's LED plate is currently switched off, so nothing draws it today."
      : // i18n-ignore-next-line — admin-only screen
        'Reverting deletes the row immediately. The deployed shard keeps the old traced outline until the next export.';
  }, [editKind, hasOverride]);

  const actionButtonStyle = isRail ? styles.railButton : styles.button;

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground }]}>
      {hasLedBasePlate ? (
        <>
          <SegmentedControl
            options={KIND_OPTIONS}
            selectedKey={editKind}
            onSelect={onEditKindChange}
            // i18n-ignore-next-line — admin-only screen
            accessibilityLabel="Boundary to draw"
            tint={editKind === 'LED_INNER' ? OUTLINE_EDITOR_COLORS.ledInner : OUTLINE_EDITOR_COLORS.overridden}
          />
          <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
            {BOUNDARY_EXPLAINER}
          </Text>
        </>
      ) : null}

      {/* Tinted with the draft colour rather than a per-mode hue: whichever mode is
          picked, what lands on the board is the same yellow stroke. */}
      <SegmentedControl
        options={canBrush ? DRAW_MODE_OPTIONS : REDRAW_ONLY_OPTIONS}
        selectedKey={canBrush ? drawMode : 'redraw'}
        onSelect={onDrawModeChange}
        // i18n-ignore-next-line — admin-only screen
        accessibilityLabel="Drawing mode"
        tint={OUTLINE_EDITOR_COLORS.draft}
      />

      {canBrush ? null : (
        <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
          {NO_OUTLINE_EXPLAINER}
        </Text>
      )}

      {drawMode === 'redraw' ? null : (
        <>
          <Stepper
            // i18n-ignore-next-line — admin-only screen
            label="Brush size"
            value={brushRadiusBoardPx}
            min={brushRadiusRange.min}
            max={brushRadiusRange.max}
            onChange={onBrushRadiusChange}
          />
          <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
            {BRUSH_SIZE_EXPLAINER}
          </Text>
        </>
      )}

      {/* Step through the board in reading order. Sits directly above the status
          line, which carries the position this pair moves through. Neither
          button carries an icon: the shared icon map has `back` but no forward
          counterpart, and one arrow on one side reads as lopsided. */}
      <View style={styles.stepRow}>
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Prev"
          variant="tonal"
          size="small"
          onPress={onPreviousPlacement}
          disabled={!canStepPlacement || saving}
          style={styles.stepButton}
        />
        {positionLabel ? (
          <Text variant="subheadline" style={styles.position}>
            {positionLabel}
          </Text>
        ) : null}
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Next"
          variant="tonal"
          size="small"
          onPress={onNextPlacement}
          disabled={!canStepPlacement || saving}
          style={styles.stepButton}
        />
      </View>

      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.status}>
        {statusLine}
      </Text>

      {errorText ? (
        <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.status}>
          {errorText}
        </Text>
      ) : null}

      <View style={isRail ? styles.buttonColumn : styles.buttonRow}>
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Save"
          variant="filled"
          size="small"
          onPress={onSave}
          disabled={!hasDraft || saving}
          loading={saving}
          style={actionButtonStyle}
        />
        {/* Undo sits next to Save rather than with the destructive actions: it
            steps back ONE stroke, where Discard throws the whole edit away. */}
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Undo"
          variant="tonal"
          size="small"
          onPress={onUndo}
          disabled={!canUndo || saving}
          style={actionButtonStyle}
        />
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Discard"
          variant="text"
          size="small"
          role="cancel"
          onPress={onDiscardDraft}
          disabled={!hasDraft || saving}
          style={actionButtonStyle}
        />
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Pick another hold"
          variant="text"
          size="small"
          onPress={onDeselect}
          disabled={!hasSelection || saving}
          style={actionButtonStyle}
        />
        <Button
          title={revertLabel}
          variant="outlined"
          size="small"
          role="destructive"
          onPress={onRevert}
          disabled={!hasOverride || saving}
          style={actionButtonStyle}
        />
      </View>

      {revertNote ? (
        <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
          {revertNote}
        </Text>
      ) : null}

      <SwitchRow
        // i18n-ignore-next-line — admin-only screen
        label="Preview it lit"
        // i18n-ignore-next-line — admin-only screen
        description="Renders the selected hold the way the app draws it, using your unsaved edit."
        value={previewLit}
        onValueChange={onPreviewLitChange}
        disabled={!previewAvailable}
      />

      {previewUnavailableNote ? (
        <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
          {previewUnavailableNote}
        </Text>
      ) : null}

      <Stepper
        // i18n-ignore-next-line — admin-only screen
        label="Overlay opacity"
        value={washOpacityPercent}
        min={washOpacityRange.min}
        max={washOpacityRange.max}
        onChange={onWashOpacityPercentChange}
      />

      <SwitchRow
        // i18n-ignore-next-line — admin-only screen
        label="Show the outline"
        // i18n-ignore-next-line — admin-only screen
        description="Off by default: a line tracing the overlay's own edge draws the eye away from where it disagrees with the hold."
        value={showSelectedOutline}
        onValueChange={onShowSelectedOutlineChange}
      />

      <SwitchRow
        // i18n-ignore-next-line — admin-only screen
        label="Draw with a finger"
        // i18n-ignore-next-line — admin-only screen
        description="Off: only an Apple Pencil draws, so a finger still pans and zooms."
        value={fingerDraw}
        onValueChange={onFingerDrawChange}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    gap: spacing[2],
  },
  status: {
    textAlign: 'center',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
  },
  // Shrinkable in the rail, where 2 × 96pt plus the position label is wider than
  // the 320pt column allows.
  stepButton: {
    flexShrink: 1,
    minWidth: 88,
  },
  position: {
    minWidth: 88,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
  },
  buttonColumn: {
    alignItems: 'stretch',
    gap: spacing[2],
  },
  button: {
    flexShrink: 1,
  },
  // `alignSelf: 'stretch'` is what the native Button reads to fill its row
  // (see `isFullWidthStyle`), not just a Yoga hint.
  railButton: {
    alignSelf: 'stretch',
  },
});
