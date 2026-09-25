// The "Show this session live" switch. Mounted twice on the Record tab, like
// RestTimerArmRow: before a session starts (PreSessionView holds the choice
// until Start) and during one (SessionVisibilityControl saves it on the spot,
// creator only).
//
// Off keeps the session out of the live-session listings and the kiosk queue
// preview. Joining by invite link works either way, which is what the off
// subtitle says.

import { useTranslation } from 'react-i18next';
import { Card } from '../Card';
import { SwitchRow } from '../SwitchRow';

type SessionVisibilityRowProps = {
  /** True when the session is (or will be) shown live. */
  isPublic: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
};

export function SessionVisibilityRow({ isPublic, onChange, disabled = false }: SessionVisibilityRowProps) {
  const { t } = useTranslation('session');
  return (
    <Card>
      <SwitchRow
        label={t('mobile.sessionVisibility.title')}
        description={
          isPublic ? t('mobile.sessionVisibility.descriptionOn') : t('mobile.sessionVisibility.descriptionOff')
        }
        // The subtitle is the whole point of the row: who can see the session.
        // Truncated, "Your crew and climbers on this board…" says nothing.
        wrapDescription
        value={isPublic}
        onValueChange={onChange}
        disabled={disabled}
      />
    </Card>
  );
}
