import { useCallback } from 'react';
import { setSessionRecordingEnabled } from '../../lib/analytics';
import { useSessionRecordingPreference } from '../../lib/session-recording-preference';
import { useAnalyticsConsent } from '../../lib/consent-hooks';
import { isProductAnalyticsGranted } from '../../lib/consent-state';

export type SessionRecordingToggle = {
  /** On only while analytics consent is granted: a saved "on" stays hidden without it. */
  value: boolean;
  /** Recording rides on analytics consent, so the switch is locked without it. */
  disabled: boolean;
  onValueChange: (next: boolean) => void;
};

/**
 * The session-recording switch's state and handler, shared by the Privacy page
 * and the feedback sheet so the two cannot drift on the consent rule.
 *
 * The handler re-reads consent at the moment of the tap rather than trusting the
 * render that drew the switch: a callback captured before consent was withdrawn
 * must not start a recording after it.
 */
export function useSessionRecordingToggle(): SessionRecordingToggle {
  const analyticsGranted = useAnalyticsConsent();
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();
  const onValueChange = useCallback(
    (next: boolean) => {
      if (!isProductAnalyticsGranted()) return;
      // Persist the choice and apply it live: start/stop the PostHog recording
      // immediately rather than waiting for the next launch.
      setSessionRecordingPreference(next);
      setSessionRecordingEnabled(next);
    },
    [setSessionRecordingPreference],
  );
  return { value: analyticsGranted && sessionRecordingEnabled, disabled: !analyticsGranted, onValueChange };
}
