import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * True while VoiceOver (iOS) or TalkBack (Android) is running.
 *
 * iOS tells React Native nothing about Voice Control, Switch Control or Full
 * Keyboard Access, so a false here does not mean nobody relies on the
 * accessibility tree.
 */
export function useScreenReaderEnabled(): boolean {
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    // A change event is newer than the first read, which may still be in flight.
    let changedBeforeRead = false;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (mounted && !changedBeforeRead) setScreenReaderEnabled(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', (enabled: boolean) => {
      changedBeforeRead = true;
      setScreenReaderEnabled(enabled);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return screenReaderEnabled;
}
