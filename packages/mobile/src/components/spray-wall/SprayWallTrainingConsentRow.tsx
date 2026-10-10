import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SprayTrainingConsentField } from '../board-discovery/BoardMetaFields';
import { isGraphqlValidationFailedError } from '../../lib/graphql/extract-error-message';
import {
  useSetSprayWallTrainingConsent,
  useSprayWallTrainingConsent,
} from '../../lib/spray/use-spray-wall-training-consent';
import { useTrainingConsentRefusalNotice } from '../../lib/spray/use-training-consent-refusal-notice';

/**
 * What a press on the held row reaches. `disabled` already blocks the press on
 * every platform (`SwitchRow`), so this is the second lock: a row with no answer
 * on it must not be able to write one.
 */
function ignorePressOnHeldRow(): void {
  // Nothing to flip yet.
}

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
 * Holds its place from the first render. While the read is out it draws the
 * same row, off and disabled, so its real height is there from the start and
 * nothing under it moves when the answer lands. It used to arrive late, and on
 * Android a tap anywhere on a switch row flips it and saves at once: a tap
 * aimed at the control below could land on the arriving row. The held row
 * cannot write. A read that failed keeps the held row and says so, rather than
 * leaving a dead switch with no reason on it or dropping the row silently.
 *
 * Nothing at all for anybody but the owner. The caller's owner check decides
 * whether to ask, and says no while it does not know who is signed in, so no
 * place is held for a viewer who may turn out not to own the wall. A viewer the
 * server does not count as the owner, or a backend that predates the field,
 * loses the row once that answer is in.
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

  if (!isOwner) return null;
  const storedConsent = consent.data;
  // Answered, and withheld: the server does not count this viewer as the owner.
  if (storedConsent === null) return null;
  const hasAnswer = typeof storedConsent === 'boolean';
  // A backend that predates the field has no such switch. There is nothing to
  // load from it, and so nothing it failed to load.
  if (!hasAnswer && consent.isError && isGraphqlValidationFailedError(consent.error)) return null;

  return (
    <SprayTrainingConsentField
      // Off while there is no answer: a dimmed, disabled, off switch reads as
      // "not ready", and the real value replaces it in place.
      value={storedConsent === true}
      onValueChange={hasAnswer ? onValueChange : ignorePressOnHeldRow}
      disabled={!hasAnswer || isSaving}
      errorMessage={hasAnswer ? error : consent.isError ? t('mobile.sprayTraining.loadError') : null}
    />
  );
}
