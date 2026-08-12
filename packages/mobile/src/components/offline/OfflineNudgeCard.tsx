// The one card every offline-nudge surface renders. Purely presentational: the
// host owns eligibility, persistence and analytics (see use-offline-nudge).
//
// No animation, so it is Reduce-Motion-safe by construction — same reasoning as
// OnboardingTipBanner, and the post-session screen already has a hero animation
// running when this appears.

import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

export type OfflineNudgeCardProps = {
  /** Already-translated. */
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  /** Optional second offer, e.g. "keep all my boards downloaded". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Omit both to render an affordance with no way to hide it. */
  dismissLabel?: string;
  onDismiss?: () => void;
  neverLabel?: string;
  onNever?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

function OfflineNudgeCardComponent({
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  dismissLabel,
  onDismiss,
  neverLabel,
  onNever,
  style,
  testID,
}: OfflineNudgeCardProps) {
  const { brandColors, systemColors } = useTheme();

  return (
    <View
      testID={testID ?? 'offline-nudge-card'}
      style={[
        styles.card,
        { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
        style,
      ]}
    >
      <View style={styles.header}>
        <Icon name="offline.download" size={22} color={brandColors.primary} />
        <Text variant="headline" style={styles.title}>
          {title}
        </Text>
      </View>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {body}
      </Text>
      <Button title={primaryLabel} variant="filled" onPress={onPrimary} style={styles.primary} />
      {secondaryLabel && onSecondary ? <Button title={secondaryLabel} variant="tonal" onPress={onSecondary} /> : null}
      {(dismissLabel && onDismiss) || (neverLabel && onNever) ? (
        <View style={styles.dismissRow}>
          {dismissLabel && onDismiss ? (
            <Button title={dismissLabel} variant="text" size="small" onPress={onDismiss} />
          ) : null}
          {neverLabel && onNever ? <Button title={neverLabel} variant="text" size="small" onPress={onNever} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export const OfflineNudgeCard = memo(OfflineNudgeCardComponent);

const styles = StyleSheet.create({
  card: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[4],
    gap: spacing[2],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  primary: {
    marginTop: spacing[2],
  },
  dismissRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
