import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { ValueSlider } from '../ValueSlider';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import type { SizePresetKey } from './spray-hold-tools';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';
import { SPRAY_EDITOR_COLORS } from './SprayHoldSvgLayer';

/**
 * The four things a finger can be doing on the wall.
 *
 * `pan` is not a no-op tool — it is the one that turns finger drawing OFF, so a
 * one-finger drag reaches the board's own pan again. On a phone, where there is
 * no Pencil to draw with and therefore no pointer type to tell the two apart,
 * this is the only way to have both.
 */
export type SprayEditorTool = 'pan' | 'add' | 'move' | 'draw';

/** Threshold steps the slider lands on. Five per tenth is finer than the eye reads off a ring. */
const THRESHOLD_STEP = 0.05;

function roundThreshold(raw: number): number {
  'worklet';
  return Math.round(raw / THRESHOLD_STEP) * THRESHOLD_STEP;
}

function thresholdNotch(value: number): number {
  'worklet';
  return Math.round(value / THRESHOLD_STEP);
}

function adjustThreshold(value: number, direction: 1 | -1): number {
  return Math.min(1, Math.max(0, roundThreshold(value + direction * THRESHOLD_STEP)));
}

type SprayEditToolbarProps = {
  tool: SprayEditorTool;
  onToolChange: (tool: SprayEditorTool) => void;
  /** Counts for the wall as it stands, already computed by the screen's selector. */
  counts: SprayEditorCounts;
  /** One line telling the climber what the current tool will do to the selection. */
  statusLine: string;
  /** The last rejected stroke or failed write, or null. */
  errorText: string | null;
  selectedCount: number;
  onDelete: () => void;
  onMerge: () => void;
  onResize: (preset: SizePresetKey) => void;
  onAcceptSelected: () => void;
  onRejectSelected: () => void;
  onAcceptAll: () => void;
  /** The target reviews `source: auto` holds. False hides the slider and the verdict row. */
  canReviewCandidates: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  threshold: number;
  onThresholdChange: (threshold: number) => void;
  onSave: () => void;
  saving: boolean;
  /**
   * The viewer may look but not write. Every control that changes the wall is
   * disabled — the screen refuses the same actions, so this is the half that
   * says why rather than the half that enforces it.
   */
  readOnly: boolean;
  hasUnsavedWork: boolean;
};

/**
 * The wall editor's control surface.
 *
 * Laid out as rows rather than one wrapping bar because the acceptance case is a
 * phone in a garage: the tool picker has to be reachable with a thumb without
 * hunting, and Save must never end up adjacent to Delete.
 */
export const SprayEditToolbar = React.memo(function SprayEditToolbar({
  tool,
  onToolChange,
  counts,
  statusLine,
  errorText,
  selectedCount,
  onDelete,
  onMerge,
  onResize,
  onAcceptSelected,
  onRejectSelected,
  onAcceptAll,
  canReviewCandidates,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  threshold,
  onThresholdChange,
  onSave,
  saving,
  readOnly,
  hasUnsavedWork,
}: SprayEditToolbarProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  // One flag in front of every disabled test, so a read-only session cannot reach
  // a control through a condition somebody forgot to extend.
  const locked = readOnly || saving;

  const toolOptions = useMemo(
    () => [
      { key: 'pan' as const, label: t('sprayEditor.tools.pan') },
      { key: 'add' as const, label: t('sprayEditor.tools.add') },
      { key: 'move' as const, label: t('sprayEditor.tools.move') },
      { key: 'draw' as const, label: t('sprayEditor.tools.draw') },
    ],
    [t],
  );

  // Zipped against SIZE_PRESETS by key rather than looked up with a computed
  // `t(...)`: the i18n linter only accepts literal keys, and a dynamic one is
  // also invisible to the orphan scanner.
  const sizeOptions = useMemo(
    () => [
      { key: 'S' as const, label: t('sprayEditor.size.s') },
      { key: 'M' as const, label: t('sprayEditor.size.m') },
      { key: 'L' as const, label: t('sprayEditor.size.l') },
      { key: 'XL' as const, label: t('sprayEditor.size.xl') },
    ],
    [t],
  );

  const formatThreshold = useCallback(
    (value: number) => t('sprayEditor.threshold.value', { percent: Math.round(value * 100) }),
    [t],
  );

  const countsLine = useMemo(() => {
    const parts = [t('sprayEditor.counts.alive', { value: counts.alive })];
    if (counts.pending > 0) parts.push(t('sprayEditor.counts.pending', { value: counts.pending }));
    if (counts.hidden > 0) parts.push(t('sprayEditor.counts.hidden', { value: counts.hidden }));
    const unsaved = counts.unsavedWrites + counts.unsavedRemovals;
    if (unsaved > 0) parts.push(t('sprayEditor.counts.unsaved', { value: unsaved }));
    return parts.join(' · ');
  }, [t, counts]);

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground }]}>
      <SegmentedControl
        options={toolOptions}
        selectedKey={tool}
        onSelect={onToolChange}
        accessibilityLabel={t('sprayEditor.tools.label')}
        tint={SPRAY_EDITOR_COLORS.manual}
      />

      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
        {countsLine}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
        {statusLine}
      </Text>
      {errorText ? (
        <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.centered}>
          {errorText}
        </Text>
      ) : null}

      <View style={styles.row}>
        {sizeOptions.map((option) => (
          <Button
            key={option.key}
            title={option.label}
            variant="tonal"
            size="small"
            onPress={() => onResize(option.key)}
            disabled={selectedCount !== 1 || locked}
            style={styles.sizeButton}
          />
        ))}
      </View>

      <View style={styles.row}>
        <Button
          title={t('sprayEditor.actions.merge')}
          variant="tonal"
          size="small"
          onPress={onMerge}
          disabled={selectedCount !== 2 || locked}
          style={styles.button}
        />
        <Button
          title={t('sprayEditor.actions.delete')}
          variant="outlined"
          size="small"
          role="destructive"
          onPress={onDelete}
          disabled={selectedCount === 0 || locked}
          style={styles.button}
        />
        <Button
          title={t('sprayEditor.actions.undo')}
          variant="text"
          size="small"
          onPress={onUndo}
          disabled={!canUndo || locked}
          style={styles.button}
        />
        <Button
          title={t('sprayEditor.actions.redo')}
          variant="text"
          size="small"
          onPress={onRedo}
          disabled={!canRedo || locked}
          style={styles.button}
        />
      </View>

      {canReviewCandidates && counts.pending > 0 ? (
        <>
          <ValueSlider
            value={threshold}
            min={0}
            max={1}
            round={roundThreshold}
            notch={thresholdNotch}
            adjust={adjustThreshold}
            format={formatThreshold}
            accessibilityLabel={t('sprayEditor.threshold.label')}
            onLiveChange={onThresholdChange}
            onCommit={onThresholdChange}
          />
          <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.centered}>
            {formatThreshold(threshold)}
          </Text>
          <View style={styles.row}>
            <Button
              title={t('sprayEditor.actions.accept')}
              variant="tonal"
              size="small"
              onPress={onAcceptSelected}
              disabled={selectedCount === 0 || locked}
              style={styles.button}
            />
            <Button
              title={t('sprayEditor.actions.reject')}
              variant="text"
              size="small"
              role="destructive"
              onPress={onRejectSelected}
              disabled={selectedCount === 0 || locked}
              style={styles.button}
            />
            <Button
              title={t('sprayEditor.actions.acceptAll')}
              variant="tonal"
              size="small"
              onPress={onAcceptAll}
              disabled={counts.pending === counts.hidden || locked}
              style={styles.button}
            />
          </View>
        </>
      ) : null}

      <Button
        title={t('sprayEditor.actions.save')}
        variant="filled"
        onPress={onSave}
        disabled={!hasUnsavedWork || locked}
        loading={saving}
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
  centered: {
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
  },
  button: {
    flexShrink: 1,
  },
  sizeButton: {
    minWidth: 56,
  },
});
