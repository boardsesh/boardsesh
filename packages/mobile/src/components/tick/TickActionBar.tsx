// The pinned terminal-action bar for both tick sheets.
//
// Two things it fixes beyond looks. The error slot is ALWAYS laid out, empty or
// not, so a failed save prints its reason without shifting the buttons out from
// under the climber's thumb — the old sheets either grew an inline red row
// (pushing the CTA down mid-tap) or threw the failure into a toast that the
// sheet covered. And the buttons are real `Button` primitives, so they carry the
// platform silhouette (Liquid Glass capsule / M3 20dp) instead of a hardcoded
// 22pt pill with a 13pt label rattling around inside it.
//
// It adds NO padding of its own: Sheet/ModalSheet's footer bar already applies
// the gutter, the top inset and the window bottom inset.
import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import type { IconName } from '../icon-map';
import { TICK_ACTION_HEIGHT, TICK_ERROR_SLOT_HEIGHT, tickActionHeight } from './tick-sheet-metrics';

const ERROR_ICON_SIZE = 13;

type TickAction = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

type TickPrimaryAction = TickAction & {
  loading?: boolean;
  icon?: IconName;
};

type TickActionBarProps = {
  primary: TickPrimaryAction;
  /** The lower-emphasis partner (create sheet: Attempt). Omitted, the primary
   *  fills the bar. */
  secondary?: TickAction;
  /** Rendered in the always-reserved slot above the buttons. */
  error?: string | null;
};

export const TickActionBar = React.memo(function TickActionBar({ primary, secondary, error }: TickActionBarProps) {
  const { brandColors, spacing } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Memoized: `Button` is a native host, so a fresh style object every render is
  // a fresh prop on both of them.
  const buttonStyles = useMemo(() => tickButtonStyles(tickActionHeight(fontScale)), [fontScale]);

  return (
    <View>
      {/* The live region sits on the ALWAYS-mounted slot, not on the message:
          a region that mounts with its content is announced inconsistently, and
          moving it would give up the reserved height that keeps the buttons
          still on a failed save. Same pair Toast.tsx uses, because these
          failures used to go through showToast and were announced. */}
      <View
        style={[styles.errorSlot, { gap: spacing[1] }]}
        testID="tick-action-error-slot"
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
      >
        {error ? (
          <>
            <Icon name="warning" size={ERROR_ICON_SIZE} color={brandColors.error} />
            <Text variant="footnote" color={brandColors.error} numberOfLines={2} style={styles.errorText}>
              {error}
            </Text>
          </>
        ) : null}
      </View>
      <View style={[styles.row, { gap: spacing[3], marginTop: spacing[2] }]} testID="tick-action-row">
        {secondary ? (
          <Button
            title={secondary.title}
            onPress={secondary.onPress}
            accessibilityLabel={secondary.accessibilityLabel}
            disabled={secondary.disabled}
            variant="tonal"
            size="large"
            style={buttonStyles.secondary}
          />
        ) : null}
        <Button
          title={primary.title}
          onPress={primary.onPress}
          accessibilityLabel={primary.accessibilityLabel}
          disabled={primary.disabled}
          loading={primary.loading}
          icon={primary.icon}
          variant="filled"
          size="large"
          style={secondary ? buttonStyles.primaryPaired : buttonStyles.primaryAlone}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  errorSlot: {
    // Reserved, always. See the note at the top of the file.
    minHeight: TICK_ERROR_SLOT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  errorText: {
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // Never the row that gives when the keyboard squeezes the column.
    flexShrink: 0,
    minHeight: TICK_ACTION_HEIGHT,
  },
});

/**
 * The two buttons' styles: one shared height (see `tickActionHeight`), and the
 * 1:2 flex split that makes the defining action the bigger object. A lone
 * primary takes the whole bar instead of hugging its label.
 */
function tickButtonStyles(height: number) {
  return {
    secondary: { flex: 1, height },
    primaryPaired: { flex: 2, height },
    primaryAlone: { flex: 1, height },
  };
}
