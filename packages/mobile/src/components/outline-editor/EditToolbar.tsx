import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HoldOutlineKind } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { OUTLINE_EDITOR_COLORS } from './OutlineSvgLayer';

// Admin-only screen: every string below is a hardcoded English literal, the same
// convention the tester-only Feature Flags / Offline Writes screens follow. No
// catalog keys, so `check:i18n:orphans` has nothing to chase.

// i18n-ignore-next-line — admin-only screen
const KIND_OPTIONS: { key: HoldOutlineKind; label: string }[] = [
  { key: 'SILHOUETTE', label: 'Silhouette' },
  { key: 'LED_INNER', label: 'LED ring' },
];

type EditToolbarProps = {
  editKind: HoldOutlineKind;
  onEditKindChange: (kind: HoldOutlineKind) => void;
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
};

/**
 * The editor's whole control surface: which boundary is being drawn, what the
 * selected placement carries today, and the three writes (store this stroke,
 * throw it away, drop the stored override).
 */
export const EditToolbar = React.memo(function EditToolbar({
  editKind,
  onEditKindChange,
  statusLine,
  positionLabel,
  onNextPlacement,
  onPreviousPlacement,
  canStepPlacement,
  errorText,
  hasDraft,
  onSave,
  onDiscardDraft,
  hasOverride,
  onRevert,
  hasSelection,
  onDeselect,
  saving,
  fingerDraw,
  onFingerDrawChange,
}: EditToolbarProps) {
  const { systemColors } = useTheme();

  // Reverting a LED_INNER row removes an annotation; there is no traced version
  // to fall back to, so the label has to say something different.
  const revertLabel = editKind === 'LED_INNER' ? 'Remove ring annotation' : 'Revert to traced';

  const revertNote = useMemo(() => {
    if (!hasOverride) return null;
    return editKind === 'LED_INNER'
      ? // i18n-ignore-next-line — admin-only screen
        'Removing the annotation deletes the row immediately. Nothing else renders it yet.'
      : // i18n-ignore-next-line — admin-only screen
        'Reverting deletes the row immediately. The deployed shard keeps the old traced outline until the next export.';
  }, [editKind, hasOverride]);

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground }]}>
      <SegmentedControl
        options={KIND_OPTIONS}
        selectedKey={editKind}
        onSelect={onEditKindChange}
        // i18n-ignore-next-line — admin-only screen
        accessibilityLabel="Boundary to draw"
        tint={editKind === 'LED_INNER' ? OUTLINE_EDITOR_COLORS.ledInner : OUTLINE_EDITOR_COLORS.overridden}
      />

      {/* Step through the board in reading order. Sits directly above the status
          line, which carries the position this pair moves through. */}
      <View style={styles.stepRow}>
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Prev"
          variant="tonal"
          size="small"
          icon="back"
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

      <View style={styles.buttonRow}>
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Save"
          variant="filled"
          size="small"
          onPress={onSave}
          disabled={!hasDraft || saving}
          loading={saving}
          style={styles.button}
        />
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Discard"
          variant="text"
          size="small"
          role="cancel"
          onPress={onDiscardDraft}
          disabled={!hasDraft || saving}
          style={styles.button}
        />
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Pick another hold"
          variant="text"
          size="small"
          onPress={onDeselect}
          disabled={!hasSelection || saving}
          style={styles.button}
        />
        <Button
          title={revertLabel}
          variant="outlined"
          size="small"
          role="destructive"
          onPress={onRevert}
          disabled={!hasOverride || saving}
          style={styles.button}
        />
      </View>

      {revertNote ? (
        <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.status}>
          {revertNote}
        </Text>
      ) : null}

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
  stepButton: {
    minWidth: 96,
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
  button: {
    flexShrink: 1,
  },
});
