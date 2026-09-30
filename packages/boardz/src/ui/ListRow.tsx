import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, type IconComponent } from './Icon';
import { Check, ChevronRight } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';
import { spacing } from './tokens';

type ListRowProps = {
  title: string;
  subtitle?: string | null;
  /** A mono line under the title: ids, counts, signal. */
  meta?: string | null;
  icon?: IconComponent;
  /** Something on the right: a grade, a button. */
  detail?: ReactNode;
  accessory?: 'chevron' | 'check' | 'none';
  onPress?: () => void;
  destructive?: boolean;
  /** A hairline under the row. */
  separator?: boolean;
};

/** A hairline row for lists of settings, boards and devices. */
export function ListRow({
  title,
  subtitle,
  meta,
  icon,
  detail,
  accessory = 'none',
  onPress,
  destructive = false,
  separator = false,
}: ListRowProps) {
  const theme = useTheme();
  const content = (
    <View style={[styles.row, separator && { borderBottomWidth: 1, borderBottomColor: theme.border1 }]}>
      {icon ? <Icon icon={icon} color={destructive ? theme.danger : theme.fg2} /> : null}
      <View style={styles.copy}>
        <Text variant="bodyStrong" color={destructive ? theme.danger : undefined} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" tone="tertiary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text variant="label" numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        ) : null}
      </View>
      {detail}
      {accessory === 'chevron' ? <Icon icon={ChevronRight} size={16} color={theme.fg3} /> : null}
      {accessory === 'check' ? <Icon icon={Check} size={18} color={theme.fg1} strokeWidth={2.25} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: accessory === 'check' }}
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: pressed ? theme.bgSurface3 : 'transparent' })}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  copy: { flex: 1, gap: 3 },
  meta: { letterSpacing: 0.4 },
});
