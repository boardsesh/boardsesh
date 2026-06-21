import { type ReactNode } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { hapticLight } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';

type ListRowProps = {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  haptic?: boolean;
  showSeparator?: boolean;
  separatorInset?: number;
  style?: ViewStyle;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  showChevron = false,
  onPress,
  haptic = true,
  showSeparator = true,
  separatorInset = 16,
  style,
  accessibilityLabel,
  accessibilityHint,
}: ListRowProps) {
  const { systemColors } = useTheme();

  const handlePress = () => {
    if (haptic) hapticLight();
    onPress?.();
  };

  const content = (
    <>
      <View style={styles.row}>
        {leading && <View style={styles.leading}>{leading}</View>}
        <View style={styles.textContainer}>
          <Text variant="body" numberOfLines={1}>
            {title}
          </Text>
          {subtitle && (
            <Text variant="subheadline" style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        {trailing && <View style={styles.trailing}>{trailing}</View>}
        {showChevron && (
          <View style={styles.chevron}>
            <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
          </View>
        )}
      </View>
      {showSeparator && (
        <View
          style={[
            styles.separator,
            { marginLeft: separatorInset + (leading ? 48 : 0), backgroundColor: systemColors.separator },
          ]}
        />
      )}
    </>
  );

  if (onPress) {
    return (
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        opacityTo={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityHint={accessibilityHint}
        style={[styles.container, style]}
      >
        {content}
      </PressableSurface>
    );
  }

  return <View style={[styles.container, style]}>{content}</View>;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 44,
  },
  leading: {
    marginRight: 12,
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  subtitle: {
    opacity: 0.6,
    marginTop: 2,
  },
  trailing: {
    marginLeft: 8,
  },
  chevron: {
    marginLeft: 4,
  },
  separator: {
    // backgroundColor is applied inline from systemColors.separator so it
    // adapts to the colour scheme on both platforms (the iOS PlatformColor
    // value is dark-mode-correct; the static rgba here was light-mode only).
    height: StyleSheet.hairlineWidth,
  },
});
