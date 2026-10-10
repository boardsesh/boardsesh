import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SprayTrainingConsentField } from '../board-discovery/BoardMetaFields';
import {
  useSetSprayWallTrainingConsent,
  useSprayWallTrainingConsent,
} from '../../lib/spray/use-spray-wall-training-consent';
import { useTrainingConsentRefusalNotice } from '../../lib/spray/use-training-consent-refusal-notice';

/**
 * "Help train hold finding" on an existing wall (SW-20, #5471).
 *
 * Saves on the tap, not with the form: it is not a board-row edit, and the
 * switch moving under the thumb is the whole confirmation. A refusal flips it
 * back and says so where the owner is looking: inline while they are on the
 * row, and in a notice over whatever they moved on to once they are not,
 * because the wall is still opted in and they have to be told
 * (`useTrainingConsentRefusalNotice`).
 *
 * "Not on the row" is two cases. The row has unmounted (Save or Back on Edit
 * board), or it is still mounted under a screen pushed over it (Edit board's
 * "Reset wall" opens the wizard on top).
 *
 * Draws nothing until the server has answered with the owner's value, and
 * nothing after a read that failed: a switch drawn from a guess would write that
 * guess on the next tap. The caller's owner check decides whether to ask, and a
 * backend that predates the field, or a viewer it does not count as the owner,
 * leaves the row out rather than showing a switch that would only be refused.
 */
export function SprayWallTrainingConsentRow({ wallUuid, isOwner }: { wallUuid: string; isOwner: boolean }) {
  const { t } = useTranslation('boards');
  const consent = useSprayWallTrainingConsent(wallUuid, isOwner);
  const [error, setError] = useState<string | null>(null);
  const noticeOffTheRow = useTrainingConsentRefusalNotice();

  // Mounted, and on the screen in front. Read when the refusal lands, which can
  // be seconds after the tap.
  const isFocused = useIsFocused();
  const ownerIsLookingRef = useRef(false);
  useEffect(() => {
    ownerIsLookingRef.current = isFocused;
    return () => {
      ownerIsLookingRef.current = false;
    };
  }, [isFocused]);
  const onRefused = useCallback(() => {
    const message = t('mobile.sprayTraining.updateError');
    if (ownerIsLookingRef.current) setError(message);
    else noticeOffTheRow(message);
  }, [t, noticeOffTheRow]);
  const { setConsent, isSaving } = useSetSprayWallTrainingConsent(wallUuid, { onRefused });

  const onValueChange = useCallback(
    (next: boolean) => {
      // A tap that lands while a flip is still saving is dropped, so it has
      // nothing to clear either.
      if (setConsent(next)) setError(null);
    },
    [setConsent],
  );

  if (!isOwner || typeof consent.data !== 'boolean') return null;
  return (
    <SprayTrainingConsentField
      value={consent.data}
      onValueChange={onValueChange}
      disabled={isSaving}
      errorMessage={error}
    />
  );
}
