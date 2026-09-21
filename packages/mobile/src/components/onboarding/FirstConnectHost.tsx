import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { registerConnectStepArm } from '../../lib/analytics-connect-step-arm';
import { nowMs } from '../../lib/clock';
import { reportError } from '../../lib/error-reporting';
import { useFeatureFlagOverrides } from '../../lib/feature-flag-overrides';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { isConnectStepArm, type ConnectStepArm } from '../../lib/onboarding/connect-step-arm';
import {
  CONNECT_STEP_FORCE_ARM_FLAG,
  enrolInConnectStep,
  type ConnectStepEnrolmentRequest,
} from '../../lib/onboarding/connect-step-enrolment';
import { shouldConfirmFirstConnect } from '../../lib/onboarding/first-connect-decision';
import {
  bindFirstConnectAccount,
  getFirstConnectSnapshot,
  markFirstConnectConfirmationShown,
  markFirstConnectPhoneConnected,
} from '../../lib/onboarding/first-connect-store';
import { useSetting } from '../../settings';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useChoose } from '../../providers/dialog-provider';
import { useFirstConnectCtaEnabled } from '../../providers/feature-flags-provider';
import { SHEET_SETTLE_MS } from '../../providers/sheet-presentation-provider';
import { useOptionalTheme } from '../../providers/theme-provider';

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
 * - Re-enrols the signed-in account when a tester changes the QA override
 *   (More → Feature Flags), so a forced arm shows at once instead of on the
 *   next launch. The gate enrols once per launch, which a test plan followed
 *   word for word would otherwise trip over.
 *
 * The device picker's own "This wall has no lights" is heard at the picker's
 * tap (`recordDevicePickerNoLights`), not here.
 *
 * Mount inside `BluetoothProviderWrapper` and `DialogProvider`.
 */
export function FirstConnectHost() {
  const { t } = useTranslation('boards');
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const accountId = isAuthenticated ? (profile?.id ?? null) : null;
  const accountCreatedAt = isAuthenticated ? profile?.createdAt : undefined;
  // While a signed-in profile is still loading there is nobody to bind yet, and
  // binding "nobody" would clear the arm for a launch's worth of early events.
  const accountKnown = !isAuthenticated || profile !== undefined;
  const enabled = useFirstConnectCtaEnabled();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [lightOnClimbTap] = useSetting('lightOnClimbTap');
  const lightOnClimbTapRef = useRef(lightOnClimbTap);
  lightOnClimbTapRef.current = lightOnClimbTap;
  const { data: activeBoard } = useActiveBoard();
  const hasBoard = activeBoard != null;
  const boardName = (activeBoard?.name ?? '').trim() || null;
  const uiVariant = useOptionalTheme()?.variant ?? null;
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

  useEffect(() => {
    if (!accountKnown) return;
    let current = true;
    void bindFirstConnectAccount(accountId).then((enrolment) => {
      if (current) registerConnectStepArm(enrolment?.arm ?? null);
    });
    return () => {
      current = false;
    };
  }, [accountId, accountKnown]);

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

  // The QA override, live. Only a CHANGE re-enrols: the value this launch
  // started with is the one the gate's own enrolment already read.
  const { overrides, loaded: overridesLoaded } = useFeatureFlagOverrides();
  const overrideValue = overrides[CONNECT_STEP_FORCE_ARM_FLAG];
  const forcedArm: ConnectStepArm | null = isConnectStepArm(overrideValue) ? overrideValue : null;
  const enrolRequest: ConnectStepEnrolmentRequest = {
    userId: accountId ?? undefined,
    accountCreatedAt,
    enabled,
    hadBoard: hasBoard,
    uiVariant,
  };
  const enrolRequestRef = useRef(enrolRequest);
  enrolRequestRef.current = enrolRequest;
  const lastForcedArmRef = useRef<ConnectStepArm | null | undefined>(undefined);
  useEffect(() => {
    if (!overridesLoaded) return;
    const previous = lastForcedArmRef.current;
    lastForcedArmRef.current = forcedArm;
    if (previous === undefined || previous === forcedArm) return;
    const request = enrolRequestRef.current;
    // Signed out, or the profile is still loading: the gate enrols this
    // account once it is known, and reads the override then.
    if (!request.userId) return;
    void enrolInConnectStep(request);
  }, [forcedArm, overridesLoaded]);

  return null;
}
