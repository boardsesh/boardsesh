import { SwitchRow } from '../SwitchRow';
import { setSessionRecordingEnabled } from '../../lib/analytics';
import { useSessionRecordingPreference } from '../../lib/session-recording-preference';
import { useAnalyticsConsent } from '../../lib/consent-hooks';
import { isProductAnalyticsGranted } from '../../lib/consent-state';

type SessionRecordingSwitchRowProps = {
  label: string;
  description: string;
};

export function SessionRecordingSwitchRow({ label, description }: SessionRecordingSwitchRowProps) {
  const analyticsGranted = useAnalyticsConsent();
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();

  return (
    <SwitchRow
      label={label}
      description={description}
      value={analyticsGranted && sessionRecordingEnabled}
      disabled={!analyticsGranted}
      onValueChange={(next) => {
        if (!isProductAnalyticsGranted()) return;
        // Persist the choice and apply it live: start/stop the PostHog
        // recording immediately rather than waiting for the next launch.
        setSessionRecordingPreference(next);
        setSessionRecordingEnabled(next);
      }}
    />
  );
}
