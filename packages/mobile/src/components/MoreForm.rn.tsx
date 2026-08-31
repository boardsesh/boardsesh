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

import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { borderRadius, spacing } from '../theme/tokens';
import { Text } from './Text';
import { ListRow } from './ListRow';
import { SectionHeader } from './SectionHeader';
import { SegmentedControl } from './SegmentedControl';
import { SwitchRow } from './SwitchRow';
import { MarkerMultiplierSlider } from './settings/MarkerMultiplierSlider';
import { assertNeverRow, selectedOptionLabel } from './MoreForm.logic';
import type { MoreFormProps, MoreRow, MoreSection } from './MoreForm.types';

function Row({ row, isLast }: { row: MoreRow; isLast: boolean }) {
  const { systemColors } = useTheme();

  switch (row.kind) {
    case 'nav':
      return (
        <ListRow
          title={row.label}
          subtitle={row.subtitle}
          trailing={row.badge ? <Text variant="caption2">{row.badge}</Text> : undefined}
          showChevron
          onPress={row.onPress}
          showSeparator={!isLast}
        />
      );
    case 'toggle':
      return (
        <View style={styles.padded}>
          <SwitchRow label={row.label} description={row.subtitle} value={row.value} onValueChange={row.onValueChange} />
        </View>
      );
    case 'segmented':
      return (
        <View style={styles.padded}>
          <SegmentedControl
            options={row.options}
            selectedKey={row.selectedKey}
            onSelect={row.onSelect}
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
    case 'button':
      return (
        <Pressable accessibilityRole="button" onPress={row.onPress} style={styles.buttonRow}>
          <Text
            variant={row.emphasis === 'subtle' ? 'footnote' : 'subheadline'}
            color={row.role === 'destructive' ? iosSystemColors.systemRed : systemColors.accent}
          >
            {row.label}
          </Text>
        </Pressable>
      );
    case 'slider':
      return (
        <View style={styles.padded}>
          <MarkerMultiplierSlider
            accessibilityLabel={row.label}
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

function Section({ section }: { section: MoreSection }) {
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
          <Row key={row.key} row={row} isLast={index === section.rows.length - 1} />
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

export function MoreFormRN({ model }: MoreFormProps) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {model.sections.map((section) => (
        <Section key={section.key} section={section} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[6],
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
