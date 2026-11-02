import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * True while an assistive technology that drives the UI is running: VoiceOver
 * on iOS; on Android any accessibility service (TalkBack, Switch Access, Voice
 * Access), which React Native reports together.
 *
 * iOS exposes no Switch Control, Voice Control or Full Keyboard Access state to
 * React Native, so a surface that hides controls must ALSO keep them in the
 * accessibility tree while hidden; this hook only lets it keep them on screen
 * where it can tell.
 */
export function useAssistiveTechnologyEnabled(): boolean {
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);
  const [accessibilityServiceEnabled, setAccessibilityServiceEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (mounted) setScreenReaderEnabled(enabled);
      })
      .catch(() => {});
    const subscriptions = [AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderEnabled)];
    if (Platform.OS === 'android') {
      AccessibilityInfo.isAccessibilityServiceEnabled()
        .then((enabled) => {
          if (mounted) setAccessibilityServiceEnabled(enabled);
        })
        .catch(() => {});
      subscriptions.push(
        AccessibilityInfo.addEventListener('accessibilityServiceChanged', setAccessibilityServiceEnabled),
      );
    }
    return () => {
      mounted = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return screenReaderEnabled || accessibilityServiceEnabled;
}
