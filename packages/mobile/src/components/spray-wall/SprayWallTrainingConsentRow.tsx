import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SprayTrainingConsentField } from '../board-discovery/BoardMetaFields';
import {
  useSetSprayWallTrainingConsent,
  useSprayWallTrainingConsent,
} from '../../lib/spray/use-spray-wall-training-consent';

/**
 * "Help train hold finding" on an existing wall (SW-20, #5471).
 *
 * Saves on the tap, not with the form: it is not a board-row edit, and the
 * switch moving under the thumb is the whole confirmation. A refusal flips it
 * back and says so inline (this is a modal route, where a toast is hidden).
 *
 * Draws nothing until the server has answered with the owner's value: the
 * caller's owner check decides whether to ask, and a backend that predates the
 * field, or a viewer it does not count as the owner, leaves the row out rather
 * than showing a switch that would only be refused.
 */
export function SprayWallTrainingConsentRow({ wallUuid, isOwner }: { wallUuid: string; isOwner: boolean }) {
  const { t } = useTranslation('boards');
  const consent = useSprayWallTrainingConsent(wallUuid, isOwner);
  const setConsent = useSetSprayWallTrainingConsent();
  const [error, setError] = useState<string | null>(null);
  const mutate = setConsent.mutate;

  const onValueChange = useCallback(
    (next: boolean) => {
      setError(null);
      mutate({ wallUuid, consent: next }, { onError: () => setError(t('mobile.sprayTraining.updateError')) });
    },
    [mutate, wallUuid, t],
  );

  if (!isOwner || typeof consent.data !== 'boolean') return null;
  return (
    <SprayTrainingConsentField
      value={consent.data}
      onValueChange={onValueChange}
      disabled={setConsent.isPending}
      errorMessage={error}
    />
  );
}
