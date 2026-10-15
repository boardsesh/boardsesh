import { PressableSurface } from './PressableSurface';
// MoreForm — React Native renderer, over the SAME `MoreFormModel` the three
// native files consume.
//
// This is not a second design. It is the escape hatch for screens that must host
// React Native content (a board-preview carousel) inside a settings list: the
// native files put the WHOLE form in one `Host`, and RN content only reaches
// inside that through `RNHostView`, whose SwiftUI→Yoga size reporting has bitten
// us before (see sheet-detent-probe.ts). Where that proves unworkable, a screen
// swaps `<MoreForm />` for `<MoreFormRN />` and changes nothing else.
//
// It is still native where it counts: SwitchRow and SegmentedControl are
// themselves platform-split @expo/ui controls, so the difference from the native
// files is one Host per control rather than one Host for the whole form — which
// is exactly what every settings screen in the app did before MoreForm existed.

import { useCallback } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';
import { ListRow } from './ListRow';
import { SectionHeader } from './SectionHeader';
import { SegmentedControl } from './SegmentedControl';
import { SwitchRow } from './SwitchRow';
import { MarkerMultiplierSlider } from './settings/MarkerMultiplierSlider';
import {
  assertNeverRow,
  disabledOptionKeys,
  guardedButtonPress,
  isButtonRowPressable,
  selectedOptionLabel,
  useOpensOutsideAppHint,
} from './MoreForm.logic';
import type { MoreFormProps, MoreRow, MoreSection } from './MoreForm.types';

function Row({ row, isLast, fitted }: { row: MoreRow; isLast: boolean; fitted?: boolean }) {
  const { systemColors } = useTheme();
  const opensOutsideAppHint = useOpensOutsideAppHint();

  switch (row.kind) {
    case 'nav': {
      // Badge, then the current value, then (for a row that leaves the app) the
      // outward arrow that replaces the chevron.
      const hasTrailing = Boolean(row.badge || row.value || row.external);
      return (
        <ListRow
          title={row.label}
          subtitle={row.subtitle}
          trailing={
            hasTrailing ? (
              <View style={styles.trailingGroup}>
                {row.badge ? <Text variant="caption2">{row.badge}</Text> : null}
                {row.value ? (
                  <Text variant="subheadline" color={systemColors.secondaryLabel}>
                    {row.value}
                  </Text>
                ) : null}
                {row.external ? <Icon name="open.external" size={14} color={systemColors.tertiaryLabel} /> : null}
              </View>
            ) : undefined
          }
          showChevron={!row.external}
          onPress={row.onPress}
          accessibilityHint={row.external ? opensOutsideAppHint : undefined}
          showSeparator={!isLast}
        />
      );
    }
    case 'value': {
      const hasTrailing = Boolean(row.busy || row.value);
      return (
        <ListRow
          title={row.label}
          subtitle={row.subtitle}
          trailing={
            hasTrailing ? (
              <View style={styles.trailingGroup}>
                {row.busy ? <ActivityIndicator size="small" /> : null}
                {row.value ? (
                  <Text variant="subheadline" color={systemColors.secondaryLabel}>
                    {row.value}
                  </Text>
                ) : null}
              </View>
            ) : undefined
          }
          onPress={row.onPress}
          accessibilityHint={row.accessibilityHint}
          accessibilityState={row.busy ? { busy: true } : undefined}
          showSeparator={!isLast}
        />
      );
    }
    case 'toggle':
      return (
        <View style={styles.padded}>
          <SwitchRow
            label={row.label}
            description={row.subtitle}
            value={row.value}
            disabled={row.disabled}
            onValueChange={row.onValueChange}
          />
        </View>
      );
    case 'segmented':
      return (
        <View style={styles.padded}>
          <SegmentedControl
            options={row.options}
            selectedKey={row.selectedKey}
            onSelect={row.onSelect}
            disabledKeys={disabledOptionKeys(row.options, row.disabled, row.disabledKeys)}
            accessibilityLabel={row.label}
          />
        </View>
      );
    // No RN menu primitive worth the weight here: a select is a short, flat list
    // of options, which is what a segmented control already is. The native files
    // render a real menu Picker; this fallback trades that for one fewer control.
    case 'select':
      return (
        <View style={styles.padded}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {row.label}
          </Text>
          <SegmentedControl
            options={row.options}
            selectedKey={row.selectedKey}
            onSelect={row.onSelect}
            disabledKeys={disabledOptionKeys(row.options, row.disabled)}
            accessibilityLabel={`${row.label}, ${selectedOptionLabel(row.options, row.selectedKey)}`}
          />
        </View>
      );
    case 'info':
      return (
        <View style={[styles.padded, styles.infoRow]}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {row.label}
          </Text>
          <Text variant="subheadline" selectable={row.selectable}>
            {row.body}
          </Text>
          {row.detail ? (
            <Text variant="caption1" color={systemColors.secondaryLabel} selectable={row.selectable}>
              {row.detail}
            </Text>
          ) : null}
        </View>
      );
    case 'button': {
      const labelColor = row.role === 'destructive' ? systemColors.error : systemColors.accent;
      return (
        <PressableSurface
          accessibilityRole="button"
          onPress={guardedButtonPress(row)}
          disabled={!isButtonRowPressable(row)}
          accessibilityState={{ busy: row.loading ?? false }}
          style={styles.buttonRow}
        >
          <View style={styles.trailingGroup}>
            {row.loading ? <ActivityIndicator size="small" color={labelColor} /> : null}
            <Text variant={row.emphasis === 'subtle' ? 'footnote' : 'subheadline'} color={labelColor}>
              {row.label}
            </Text>
          </View>
        </PressableSurface>
      );
    }
    case 'slider':
      return (
        <View style={[styles.padded, fitted ? styles.fittedSlider : null]}>
          <MarkerMultiplierSlider
            accessibilityLabel={row.label}
            showLabel
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step}
            format={row.format}
            onChange={row.onValueChange}
            onChangeEnd={row.onCommit}
          />
        </View>
      );
    case 'custom':
      // Already React Native — it renders inline, with no host in between. The
      // whole reason this renderer exists.
      return <View style={{ height: row.height }}>{row.content}</View>;
    default:
      return assertNeverRow(row);
  }
}

function Section({ section, fitted }: { section: MoreSection; fitted?: boolean }) {
  const { systemColors } = useTheme();
  // A section of nothing but buttons gets no card — a bare "Reset" reads as an
  // action, not as a one-row list. Matches what the native files do.
  const isActionSection = section.rows.every((row) => row.kind === 'button');
  const isFullBleed = section.rows.some((row) => row.kind === 'custom' && row.fullBleed);

  return (
    <View style={styles.section}>
      {section.title ? <SectionHeader title={section.title} /> : null}
      <View
        style={
          isActionSection || isFullBleed
            ? undefined
            : [styles.card, { backgroundColor: systemColors.secondaryBackground }]
        }
      >
        {section.rows.map((row, index) => (
          <Row key={row.key} row={row} isLast={index === section.rows.length - 1} fitted={fitted} />
        ))}
      </View>
      {section.footer ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
          {section.footer}
        </Text>
      ) : null}
    </View>
  );
}

export type MoreFormRNProps = MoreFormProps & {
  /** Measured preview screens fit their content before enabling overflow scroll. */
  fitted?: boolean;
  scrollable?: boolean;
  /** Actual labels, controls, footers and gaps; excludes fixed custom rows. */
  onReservedHeightChange?: (height: number) => void;
};

export function MoreFormRN({ model, fitted, scrollable = true, onReservedHeightChange }: MoreFormRNProps) {
  const customHeight = model.sections.reduce(
    (total, section) =>
      total + section.rows.reduce((height, row) => height + (row.kind === 'custom' ? row.height : 0), 0),
    0,
  );
  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onReservedHeightChange?.(Math.max(0, event.nativeEvent.layout.height - customHeight));
    },
    [customHeight, onReservedHeightChange],
  );
  const content = (
    <View
      style={fitted ? styles.fittedContent : styles.content}
      onLayout={onReservedHeightChange ? handleContentLayout : undefined}
    >
      {model.sections.map((section) => (
        <Section key={section.key} section={section} fitted={fitted} />
      ))}
    </View>
  );
  return scrollable ? (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scrollContent}>
      {content}
    </ScrollView>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[6],
  },
  scrollContent: {
    flexGrow: 1,
  },
  fittedContent: {
    gap: spacing[3],
  },
  fittedSlider: {
    paddingVertical: spacing[1],
  },
  section: {
    gap: spacing[2],
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
  },
  padded: {
    padding: spacing[3],
    gap: spacing[2],
  },
  infoRow: {
    gap: spacing[1],
  },
  trailingGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  buttonRow: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[4],
  },
  footer: {
    paddingHorizontal: spacing[4],
    lineHeight: 18,
  },
});
