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
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import type { IconName } from '../icon-map';
import { TICK_ACTION_HEIGHT, TICK_ERROR_SLOT_HEIGHT } from './tick-sheet-metrics';

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
            style={styles.secondaryButton}
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
          // 2:1 beside a secondary so the defining action reads as the bigger
          // object; 1 on its own so it fills the bar instead of hugging its label.
          style={secondary ? styles.primaryButtonPaired : styles.primaryButtonAlone}
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
    // Both matter once the keyboard is up. The sheet's column is a FIXED height
    // on iOS (the #3330 detent bound) and ModalSheet's KeyboardAvoidingView pads
    // the bottom by the keyboard height, so everything inside gets squeezed into
    // what's left. Without `flexShrink: 0` this row is a candidate for that
    // squeeze; without `alignItems: 'center'` the default `stretch` then hands
    // each native button host whatever odd height the squeezed row ended up
    // with, and the two buttons stop lining up.
    alignItems: 'center',
    flexShrink: 0,
    minHeight: TICK_ACTION_HEIGHT,
  },
  // Explicit height rather than relying on the row: `alignItems: 'center'` sizes
  // each child to its own content, and a SwiftUI/Compose button host measures
  // from its label, so the tonal Attempt and the filled Send (which also carries
  // an icon and a spinner) would otherwise settle at slightly different heights.
  secondaryButton: {
    flex: 1,
    height: TICK_ACTION_HEIGHT,
  },
  primaryButtonPaired: {
    flex: 2,
    height: TICK_ACTION_HEIGHT,
  },
  primaryButtonAlone: {
    flex: 1,
    height: TICK_ACTION_HEIGHT,
  },
});
