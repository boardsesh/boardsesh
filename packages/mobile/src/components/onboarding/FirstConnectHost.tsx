import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { registerConnectStepArm } from '../../lib/analytics-connect-step-arm';
import { nowMs } from '../../lib/clock';
import { reportError } from '../../lib/error-reporting';
import { useFeatureFlagOverrides } from '../../lib/feature-flag-overrides';
import { DEFAULT_KEEP_LIGHTING, sanitiseKeepLighting } from '../../lib/keep-lighting';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { isConnectStepArm, type ConnectStepArm } from '../../lib/onboarding/connect-step-arm';
import {
  CONNECT_STEP_FORCE_ARM_FLAG,
  enrolInConnectStep,
  type ConnectStepEnrolmentRequest,
} from '../../lib/onboarding/connect-step-enrolment';
import { setFirstConnectConfirmationShowing } from '../../lib/onboarding/first-connect-confirmation-presence';
import {
  firstConnectAlwaysDrives,
  firstConnectConfirmationCopy,
  shouldConfirmFirstConnect,
  type FirstConnectConfirmationCopy,
} from '../../lib/onboarding/first-connect-decision';
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
import { useFirstConnectCtaEnabled, useWallSwipeToDriveEnabled } from '../../providers/feature-flags-provider';
import { useIsCrewSession } from '../../providers/queue-provider';
import { SHEET_SETTLE_MS } from '../../providers/sheet-presentation-provider';
import { useOptionalTheme } from '../../providers/theme-provider';

const CONFIRMATION_ACKNOWLEDGED = 'got_it';

type ConfirmationCopyInput = Parameters<typeof firstConnectConfirmationCopy>[0];

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
 * - Shows the one-time "Connected to {{board}}" confirmation, in both arms,
 *   saying what lights from here on under this climber's lighting settings
 *   (`firstConnectConfirmationCopy`). From the moment it sees the connect it
 *   will confirm (before recording it, which hides the Climbs card) until the
 *   dialog closes, the Climbs list's tips and the player's preview-first card
 *   stand down (`first-connect-confirmation-presence.ts`).
 * - Re-enrols the signed-in account when a tester changes the QA override
 *   (More → Feature Flags), so a forced arm shows at once instead of on the
 *   next launch. The gate enrols once per launch, which a test plan followed
 *   word for word would otherwise trip over.
 *
 * The device picker's own "This wall has no lights" is heard at the picker's
 * tap (`recordDevicePickerNoLights`), not here.
 *
 * Mount inside `QueueProvider`, `BluetoothProviderWrapper` and `DialogProvider`.
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
  const { data: activeBoard } = useActiveBoard();
  const hasBoard = activeBoard != null;
  const boardName = (activeBoard?.name ?? '').trim() || null;
  const uiVariant = useOptionalTheme()?.variant ?? null;
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;
  const bluetooth = useOptionalBluetoothContext();
  const isConnected = bluetooth?.isConnected ?? false;
  // What the confirmation says lights from here on: read when it is decided,
  // the way Always drive the wall and Put on board read it
  // (`firstConnectConfirmationCopy`).
  const [alwaysDrive] = useSetting('alwaysDrive');
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const inSession = useIsCrewSession();
  const keepLightingEnabled = useWallSwipeToDriveEnabled();
  const copyInput: ConfirmationCopyInput = {
    alwaysDrive: firstConnectAlwaysDrives({
      alwaysDrive,
      swipeToDriveEnabled: keepLightingEnabled,
      drivesInSession,
      inSession,
    }),
    keepLighting: keepLightingEnabled
      ? {
          keepLighting: sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING),
          drivesInSession,
          inSession,
        }
      : null,
  };
  const copyInputRef = useRef(copyInput);
  copyInputRef.current = copyInput;
  const choose = useChoose();
  const showConfirmation = useCallback(
    (boardName: string | null, copy: FirstConnectConfirmationCopy) => {
      const messageFor = (): string => {
        switch (copy.variant) {
          case 'always_drive':
            return t('mobile.firstConnect.confirm.bodyAlwaysDrive');
          case 'window':
            return t('mobile.firstConnect.confirm.bodyWindow', { seconds: copy.seconds });
          case 'window_minute':
            return t('mobile.firstConnect.confirm.bodyWindowMinute');
          case 'window_minutes':
            return t('mobile.firstConnect.confirm.bodyWindowMinutes', { minutes: copy.minutes });
          case 'until_stop':
            return t('mobile.firstConnect.confirm.bodyUntilStop');
          case 'put_on_board':
            return t('mobile.firstConnect.confirm.bodyPutOnBoard');
        }
      };
      choose({
        title: boardName
          ? t('mobile.firstConnect.confirm.title', { board: boardName })
          : t('mobile.firstConnect.confirm.titleNoName'),
        message: messageFor(),
        options: [{ value: CONFIRMATION_ACKNOWLEDGED, label: t('mobile.firstConnect.confirm.gotIt') }],
        cancelValue: CONFIRMATION_ACKNOWLEDGED,
      })
        .catch(reportError)
        .finally(() => setFirstConnectConfirmationShowing(false));
    },
    [choose, t],
  );
  const showConfirmationRef = useRef(showConfirmation);
  showConfirmationRef.current = showConfirmation;

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
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (confirmationTimerRef.current !== null) clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
      // This host is the presence's only writer, so nothing is coming any more.
      setFirstConnectConfirmationShowing(false);
    };
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    // Recording this connect is what hides the Climbs card, and the list's tips
    // and the player's preview-first card are waiting behind that card. So the
    // confirmation is announced first, from the phone's state as it stands,
    // before any of the writes below: otherwise one of them takes the slot in
    // the moment between and the dialog lands on top of it. With the state not
    // read yet there is no card up to hide, and the decision below announces it.
    const pending = getFirstConnectSnapshot();
    const announced =
      pending.device !== null &&
      shouldConfirmFirstConnect({ enrolment: pending.enrolment, enabled: enabledRef.current, device: pending.device });
    if (announced) setFirstConnectConfirmationShowing(true);
    // Whether this run holds the presence, and whether it handed it to the dialog.
    let held = announced;
    let scheduled = false;
    void (async () => {
      const before = await markFirstConnectPhoneConnected(nowMs());
      const shouldConfirm =
        before !== null &&
        shouldConfirmFirstConnect({
          enrolment: getFirstConnectSnapshot().enrolment,
          enabled: enabledRef.current,
          device: before,
        });
      if (!shouldConfirm || !mountedRef.current) {
        if (held) setFirstConnectConfirmationShowing(false);
        return;
      }
      // The player's preview-first card says the same thing: it waits from
      // here until the dialog closes.
      held = true;
      setFirstConnectConfirmationShowing(true);
      await markFirstConnectConfirmationShown(nowMs());
      // An unmount meanwhile already let everything waiting go.
      if (!mountedRef.current) return;
      const boardName = boardNameRef.current;
      const copy = firstConnectConfirmationCopy(copyInputRef.current);
      // After the device picker has finished sliding away, so the dialog does
      // not land on a sheet mid-dismiss.
      scheduled = true;
      confirmationTimerRef.current = setTimeout(() => {
        confirmationTimerRef.current = null;
        showConfirmationRef.current(boardName, copy);
      }, SHEET_SETTLE_MS);
    })().catch((error: unknown) => {
      // Nothing will show, so nothing waits for it.
      if (held && !scheduled) setFirstConnectConfirmationShowing(false);
      reportError(error);
    });
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
