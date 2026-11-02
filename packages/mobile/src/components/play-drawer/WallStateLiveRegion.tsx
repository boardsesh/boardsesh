// Android's channel for the player's one-off spoken lines (the preview-first
// line, `useWallStateAnnouncer`): a hidden polite live region, because
// announceForAccessibility is deprecated from API 36. iOS speaks the same line
// through a queued announcement, so this renders nothing there.
//
// It stays mounted with empty text so the line arriving is a content change,
// which is what a live region reports. Hidden by size and a clear text colour,
// never by opacity: Android treats a view with alpha 0 as invisible to the
// user, and TalkBack ignores a live region it can't see.

import { memo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text } from '../Text';

function WallStateLiveRegionComponent({ text }: { text: string | null }) {
  if (Platform.OS !== 'android') return null;
  return (
    <View
      testID="play-drawer-wall-live-region"
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={styles.region}
    >
      <Text variant="footnote" color="transparent">
        {text ?? ''}
      </Text>
    </View>
  );
}

export const WallStateLiveRegion = memo(WallStateLiveRegionComponent);

const styles = StyleSheet.create({
  region: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
});
