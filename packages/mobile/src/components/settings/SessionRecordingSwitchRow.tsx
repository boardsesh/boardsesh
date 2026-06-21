import { SwitchRow } from '../SwitchRow';
import { setSessionRecordingEnabled } from '../../lib/analytics';
import { useSessionRecordingPreference } from '../../lib/session-recording-preference';

type SessionRecordingSwitchRowProps = {
  label: string;
  description: string;
};

export function SessionRecordingSwitchRow({ label, description }: SessionRecordingSwitchRowProps) {
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();

  return (
    <SwitchRow
      label={label}
      description={description}
      value={sessionRecordingEnabled}
      onValueChange={(next) => {
        // Persist the choice and apply it live: start/stop the PostHog
        // recording immediately rather than waiting for the next launch.
        setSessionRecordingPreference(next);
        setSessionRecordingEnabled(next);
      }}
    />
  );
}
