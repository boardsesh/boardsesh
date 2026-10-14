import { SwitchRow } from '../SwitchRow';
import { useSessionRecordingToggle } from './use-session-recording-toggle';

type SessionRecordingSwitchRowProps = {
  label: string;
  description: string;
};

export function SessionRecordingSwitchRow({ label, description }: SessionRecordingSwitchRowProps) {
  const { value, disabled, onValueChange } = useSessionRecordingToggle();
  return (
    <SwitchRow
      label={label}
      description={description}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
    />
  );
}
