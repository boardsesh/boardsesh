import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { registerConnectStepArm } from '../../lib/analytics-connect-step-arm';
import { nowMs } from '../../lib/clock';
import { reportError } from '../../lib/error-reporting';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { shouldConfirmFirstConnect } from '../../lib/onboarding/first-connect-decision';
import {
  bindFirstConnectAccount,
  getFirstConnectSnapshot,
  markFirstConnectConfirmationShown,
  markFirstConnectNoLights,
  markFirstConnectPhoneConnected,
} from '../../lib/onboarding/first-connect-store';
import { useSetting } from '../../settings';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useChoose } from '../../providers/dialog-provider';
import { useFirstConnectCtaEnabled } from '../../providers/feature-flags-provider';
import { SHEET_SETTLE_MS } from '../../providers/sheet-presentation-provider';

const CONFIRMATION_ACKNOWLEDGED = 'got_it';

/**
 * The connect-step test's (#5654, PR 7) always-mounted half. Renders nothing.
 *
 * - Binds the store to the signed-in account, and keeps the `arm_connect_step`
 *   super property on the arm of whoever is signed in (cleared for anyone not
 *   enrolled).
 * - Records this phone's first successful connect, the fact every treatment
 *   surface keys on, for EVERY climber: the phone's history is worth keeping
 *   whether or not this account is in the test. It only watches the Bluetooth
 *   context's public `isConnected`; nothing under `lib/ble/` changes.
 * - Shows the one-time "Connected to {{board}}" confirmation, in both arms.
 * - Treats the device picker's own "This wall has no lights" (the phone taking
 *   the wall without Bluetooth on a board that says it has lights) the same as
 *   the card's, so the pill stops offering a connect the wall cannot take.
 *
 * Mount inside `BluetoothProviderWrapper` and `DialogProvider`.
 */
export function FirstConnectHost() {
  const { t } = useTranslation('boards');
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const accountId = isAuthenticated ? (profile?.id ?? null) : null;
  const enabled = useFirstConnectCtaEnabled();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [lightOnClimbTap] = useSetting('lightOnClimbTap');
  const lightOnClimbTapRef = useRef(lightOnClimbTap);
  lightOnClimbTapRef.current = lightOnClimbTap;
  const { data: activeBoard } = useActiveBoard();
  const boardName = (activeBoard?.name ?? '').trim() || null;
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;
  const choose = useChoose();
  const showConfirmation = useCallback(
    (boardName: string | null) => {
      choose({
        title: boardName
          ? t('mobile.firstConnect.confirm.title', { board: boardName })
          : t('mobile.firstConnect.confirm.titleNoName'),
        message: t('mobile.firstConnect.confirm.body'),
        options: [{ value: CONFIRMATION_ACKNOWLEDGED, label: t('mobile.firstConnect.confirm.gotIt') }],
        cancelValue: CONFIRMATION_ACKNOWLEDGED,
      }).catch(reportError);
    },
    [choose, t],
  );
  const showConfirmationRef = useRef(showConfirmation);
  showConfirmationRef.current = showConfirmation;

  const bluetooth = useOptionalBluetoothContext();
  const isConnected = bluetooth?.isConnected ?? false;
  const virtualWallHeld = bluetooth?.virtualWallHeld ?? false;
  const ledless = bluetooth?.ledless ?? false;

  useEffect(() => {
    let current = true;
    void bindFirstConnectAccount(accountId).then((enrolment) => {
      if (current) registerConnectStepArm(enrolment?.arm ?? null);
    });
    return () => {
      current = false;
    };
  }, [accountId]);

  // The first successful connect. The Bluetooth provider flips `isConnected`
  // once the link is up, whichever surface asked for it.
  // Only an unmount cancels the confirmation: a link that drops a moment after
  // it came up still happened, and the dialog is already marked as shown.
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmationTimerRef.current !== null) clearTimeout(confirmationTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isConnected) return;
    void (async () => {
      const before = await markFirstConnectPhoneConnected(nowMs());
      if (before === null) return;
      const shouldConfirm = shouldConfirmFirstConnect({
        enrolment: getFirstConnectSnapshot().enrolment,
        enabled: enabledRef.current,
        device: before,
        lightOnClimbTap: lightOnClimbTapRef.current,
      });
      if (!shouldConfirm) return;
      await markFirstConnectConfirmationShown(nowMs());
      const boardName = boardNameRef.current;
      // After the device picker has finished sliding away, so the dialog does
      // not land on a sheet mid-dismiss.
      confirmationTimerRef.current = setTimeout(() => {
        confirmationTimerRef.current = null;
        showConfirmationRef.current(boardName);
      }, SHEET_SETTLE_MS);
    })().catch(reportError);
  }, [isConnected]);

  // The device picker's "This wall has no lights" takes the wall without
  // Bluetooth. On a board that does not already say it has no lights, that is
  // the climber telling us the same thing the card's button does.
  useEffect(() => {
    if (!virtualWallHeld || ledless) return;
    const device = getFirstConnectSnapshot().device;
    if (device === null || device.connectedAt !== null || device.noLightsAt !== null) return;
    void markFirstConnectNoLights(nowMs()).then(() => {
      if (getFirstConnectSnapshot().enrolment === null) return;
      track(SHARED_EVENTS.BoardLightsDeclined, { surface: 'device_picker' });
    });
  }, [virtualWallHeld, ledless]);

  return null;
}
