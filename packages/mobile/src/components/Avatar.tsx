import { View, Image, StyleSheet, PixelRatio } from 'react-native';
import { snapToAllowedImageSize } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { getInitials } from '../lib/get-initials';
import { brandColors } from '../theme/colors';
import { iosSystemColors, neutralGray } from '../theme/ios-colors';

type AvatarProps = {
  uri?: string | null;
  name?: string | null;
  size?: number;
  /** Overrides the derived label (defaults to `name`). */
  accessibilityLabel?: string;
};

/**
 * Request a pre-sized variant for backend-served avatars so the device
 * fetches a small image instead of the full user upload (which can be
 * multiple megapixels). Snaps the display size (× DPR) to a backend-honored
 * bucket via the shared allowlist. Third-party avatar URLs are passed
 * through — the backend can only resize what it stores.
 */
export function sizedAvatarUri(uri: string, displaySize: number): string {
  if (!uri.includes('/static/avatars/')) return uri;
  const bucket = snapToAllowedImageSize(Math.ceil(displaySize * PixelRatio.get()));
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}size=${bucket}`;
}

export function Avatar({ uri, name, size = 40, accessibilityLabel: accessibilityLabelProp }: AvatarProps) {
  const borderRadius = size / 2;

  const accessibilityLabel = accessibilityLabelProp ?? name ?? undefined;

  if (uri) {
    return (
      // Uses react-native's core <Image> (not expo-image), so there's no
      // allowDownscaling prop — but none is needed: RCTImageLoader decodes
      // and downscales off the main thread, and sizedAvatarUri requests a
      // ≤280px source, so any resize is trivial. Avatars were never part of
      // the expo-image main-thread hang this PR fixes.
      <Image
        source={{ uri: sizedAvatarUri(uri, size) }}
        accessibilityLabel={accessibilityLabel}
        style={[styles.image, { width: size, height: size, borderRadius }]}
      />
    );
  }

  const initials = name ? getInitials(name) : '?';
  const fontSize = size * 0.4;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.fallback, { width: size, height: size, borderRadius }]}
    >
      {/* Override lineHeight too: the caption1 variant pins it to 16, which is
          smaller than fontSize once size > 40 and clips the top of the
          initials. Match it to fontSize so the glyph's line box fits. */}
      <Text
        variant="caption1"
        color={iosSystemColors.white}
        style={{ fontSize, lineHeight: fontSize, fontWeight: '600' }}
      >
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: neutralGray,
  },
  fallback: {
    backgroundColor: brandColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
