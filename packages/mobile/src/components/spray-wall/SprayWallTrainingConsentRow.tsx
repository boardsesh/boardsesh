import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SprayTrainingConsentField } from '../board-discovery/BoardMetaFields';
import { useToast } from '../../providers/toast-provider';
import {
  useSetSprayWallTrainingConsent,
  useSprayWallTrainingConsent,
} from '../../lib/spray/use-spray-wall-training-consent';

/**
 * "Help train hold finding" on an existing wall (SW-20, #5471).
 *
 * Saves on the tap, not with the form: it is not a board-row edit, and the
 * switch moving under the thumb is the whole confirmation. A refusal flips it
 * back and says so: inline while the row is on screen (its hosts are modal
 * routes, where a toast draws behind), and as a toast once the row has gone,
 * because the owner who tapped Save or swiped the screen away is no longer
 * looking at the inline slot and the wall is still opted in.
 *
 * Draws nothing until the server has answered with the owner's value, and
 * nothing after a read that failed: a switch drawn from a guess would write that
 * guess on the next tap. The caller's owner check decides whether to ask, and a
 * backend that predates the field, or a viewer it does not count as the owner,
 * leaves the row out rather than showing a switch that would only be refused.
 */
export function SprayWallTrainingConsentRow({ wallUuid, isOwner }: { wallUuid: string; isOwner: boolean }) {
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const consent = useSprayWallTrainingConsent(wallUuid, isOwner);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const onRefused = useCallback(() => {
    const message = t('mobile.sprayTraining.updateError');
    if (mountedRef.current) setError(message);
    else showToast(message, 'error');
  }, [t, showToast]);
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
