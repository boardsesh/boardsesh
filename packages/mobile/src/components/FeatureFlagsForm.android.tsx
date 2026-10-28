// FeatureFlagsForm — Android implementation, a Jetpack Compose `LazyColumn` of
// Material cards via @expo/ui/jetpack-compose.
//
// The whole tester-only Feature Flags screen is ONE `Host` containing a single
// `LazyColumn` — the Compose counterpart to the iOS `Form`. This is the PR-2
// consolidation: instead of one `Host` per control, the entire list lives under
// one `Host`. A `LazyColumn` virtualizes its items, so it must be given a bounded
// height — hence `style={{ flex: 1 }}` on the Host (NOT `matchContents`, which the
// per-row controls use to report intrinsic height back to RN).
//
// Each direct child of the LazyColumn is a list item: the title, the notice, one
// Material `Card` per flag, then the reset button. Brand colours come from the
// `expo-ui-modifiers` bridge; M3 surface/label colours come from the Compose
// Material theme the Host sets up.
//
// All copy is hardcoded English with `i18n-ignore` — tester-only.

import { ComposeHost } from './ComposeHost.android';
import {
  LazyColumn,
  Card,
  Column,
  Text,
  Button,
  SingleChoiceSegmentedButtonRow,
  SegmentedButton,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, alpha } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { segmentedBrandColors } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import type { FeatureFlagsFormProps } from './FeatureFlagsForm.types';

// The gap above every item after the title. A padding modifier rather than the
// LazyColumn's `spacedBy` arrangement, which never reached the device (see
// MoreForm.android.tsx).
const ITEM_GAP = padding(0, spacing[3], 0, 0);

export function FeatureFlagsForm({ rows, onSelect, onReset, canReset, noticeText, title }: FeatureFlagsFormProps) {
  const { brandColors } = useTheme();
  const segmentColors = segmentedBrandColors(brandColors);

  return (
    <ComposeHost style={styles.host}>
      <LazyColumn contentPadding={{ start: spacing[4], top: spacing[4], end: spacing[4], bottom: spacing[10] }}>
        {/* i18n-ignore-next-line — tester-only screen */}
        <Text style={{ typography: 'titleLarge' }}>{title}</Text>
        <Text style={{ typography: 'bodySmall' }} modifiers={[ITEM_GAP, alpha(0.6)]}>
          {noticeText}
        </Text>

        {rows.map((row) => (
          <Column key={row.key} modifiers={[fillMaxWidth(), ITEM_GAP]}>
            <Card modifiers={[fillMaxWidth()]}>
              <Column
                modifiers={[padding(spacing[4], spacing[3], spacing[4], spacing[3])]}
                verticalArrangement={{ spacedBy: spacing[2] }}
              >
                <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
                <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
                  {row.description}
                </Text>
                <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
                  {row.options.map((option) => (
                    <SegmentedButton
                      key={option.key}
                      selected={option.key === row.choice}
                      onClick={() => onSelect(row.key, option.key)}
                      colors={segmentColors}
                    >
                      {/* The label slot is a native composable SLOT — its child must be
                        a Compose `Text`, not a raw string, or it doesn't render and
                        isn't exposed to the a11y tree. */}
                      <SegmentedButton.Label>
                        <Text>{option.label}</Text>
                      </SegmentedButton.Label>
                    </SegmentedButton>
                  ))}
                </SingleChoiceSegmentedButtonRow>
                <Text style={{ typography: 'labelSmall' }} modifiers={[alpha(0.6)]}>
                  {row.effectiveLabel}
                </Text>
              </Column>
            </Card>
          </Column>
        ))}

        {/* `enabled={canReset}` greys the button and blocks the tap when there's
            nothing to reset. The label is a Text child (Button content is a slot). */}
        <Column modifiers={[fillMaxWidth(), ITEM_GAP]}>
          <Button onClick={onReset} enabled={canReset} modifiers={[fillMaxWidth()]}>
            {/* i18n-ignore-next-line — tester-only screen */}
            <Text>Reset all overrides</Text>
          </Button>
        </Column>
      </LazyColumn>
    </ComposeHost>
  );
}

const styles = StyleSheet.create({
  // A LazyColumn virtualizes its rows and needs a bounded height to fill.
  host: {
    flex: 1,
  },
});
