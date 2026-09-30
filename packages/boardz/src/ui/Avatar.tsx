import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { FONT } from './fonts';
import { Text } from './Text';
import { useTheme } from './theme';

type AvatarProps = { name: string; imageUrl: string | null; size?: number };

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/** A photo, or mono initials on a quiet fill. */
export function Avatar({ name, imageUrl, size = 40 }: AvatarProps) {
  const theme = useTheme();
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (imageUrl) {
    return <Image source={{ uri: imageUrl }} style={shape} accessibilityLabel={name} cachePolicy="memory-disk" />;
  }
  const fontSize = Math.round(size * 0.34);
  return (
    <View
      style={[styles.fallback, shape, { backgroundColor: theme.bgSurface3, borderColor: theme.border1 }]}
      accessibilityLabel={name}
    >
      <Text
        variant="mono"
        tone="secondary"
        style={{ fontFamily: FONT.monoMedium, fontSize, lineHeight: fontSize + 2, letterSpacing: 0.3 }}
      >
        {initials(name) || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
