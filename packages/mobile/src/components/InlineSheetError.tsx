import { useEffect, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import { announceQueued } from '../lib/announce-queued';
import { spacing } from '../theme/tokens';

/** Form errors wrap in the scroll body and remain readable at every text size. */
export function InlineSheetError({
  message,
  visible,
  scope,
}: {
  message: string | null;
  visible: boolean;
  scope: string;
}) {
  const { systemColors } = useTheme();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !message) {
      previous.current = null;
      return;
    }
    const announcement = `${scope}:${message}`;
    if (announcement === previous.current) return;
    previous.current = announcement;
    if (Platform.OS === 'ios') announceQueued(message);
  }, [message, visible, scope]);
  if (!visible || !message) return null;
  return (
    <Text
      variant="footnote"
      color={systemColors.error}
      maxFontSizeMultiplier={0}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.error}
    >
      {message}
    </Text>
  );
}
const styles = StyleSheet.create({ error: { marginVertical: spacing[2] } });
