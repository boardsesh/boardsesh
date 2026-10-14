import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PrivacyResourceAudience, PrivacySettings } from '@boardsesh/graphql/operations/privacy';
import { MoreForm } from '../MoreForm';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { decideAnalyticsConsent } from '../../providers/consent-provider';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../lib/auth-store';
import { useAnalyticsPreference, useAnalyticsRegionDefault } from '../../lib/consent-hooks';
import { reportHandledError } from '../../lib/error-reporting';
import { hapticSelection } from '../../lib/haptics';
import { openExternalUrl } from '../../lib/open-url';
import { trackSettingChanged, withSettingTracking } from '../../lib/settings-analytics';
import { useProfile } from '../../lib/graphql/hooks';
import {
  useIncomingFollowRequests,
  usePrivacySettings,
  useSetAnonymousOnForeignBoards,
  useUpdatePrivacySettings,
} from '../../lib/graphql/hooks/use-privacy';
import { useSessionRecordingToggle } from '../settings/use-session-recording-toggle';
import {
  ANALYTICS_ROW_KEY,
  DEFAULT_SESSION_AUDIENCES,
  PRIVATE_ACCOUNT_ROW_KEY,
  SESSION_DEFAULT_ROW_KEY,
  buildPrivacyModel,
} from './privacy-model';
import {
  accountSwitchConfirmation,
  accountSwitchPayload,
  accountSwitchReopensSessions,
  sessionAudienceConfirmation,
  type PrivacyConfirmCopy,
} from './privacy-settings-changes';
import { PRIVACY_POLICY_URL } from './privacy-policy-url';
import type { PrivacyPeopleMode } from './PrivacyPeopleScreen';

const SETTINGS_PAGE = 'privacy';
/**
 * Rows `withSettingTracking` leaves alone. The account switch and the session
 * default can be cancelled at a confirm or fail to save, so they report the
 * change themselves once the write lands. Analytics is never reported: turning
 * it on is not counted (consent is still off when the event fires), so counting
 * only the turn-offs would skew the metric.
 */
const UNTRACKED_ROW_KEYS: ReadonlySet<string> = new Set([
  PRIVATE_ACCOUNT_ROW_KEY,
  SESSION_DEFAULT_ROW_KEY,
  ANALYTICS_ROW_KEY,
]);

/** Who was signed in when a change was asked, so an answer never lands on another account. */
type ViewerScope = { viewerId: string | undefined; credentialGeneration: number };

function isDefaultSessionAudience(key: string): key is (typeof DEFAULT_SESSION_AUDIENCES)[number] {
  return (DEFAULT_SESSION_AUDIENCES as readonly string[]).includes(key);
}

function openPeople(mode: PrivacyPeopleMode) {
  router.push({ pathname: '/settings/privacy-people', params: { mode } });
}

/**
 * Privacy — every privacy control in one place, as a native form.
 *
 * Each switch and the session-default select writes the moment it changes;
 * there is no Save. A change that widens who can see you (going public, or a
 * Public default on a private account) asks first, and while it asks the row
 * draws the new value: the native control already moved, and only a prop that
 * changes back (on cancel) makes it move back. The account switch reads the
 * server again before it writes, so the session default it carries along is
 * built from what is saved now, not from a cached copy.
 */
export function PrivacySettingsScreen() {
  const { t } = useTranslation('settings');
  const { isAuthenticated } = useAuth();
  const { effectiveOffline } = useConnectivity();
  const confirm = useConfirm();
  const profileQuery = useProfile();
  const viewerId = profileQuery.data?.id;
  const settings = usePrivacySettings();
  const update = useUpdatePrivacySettings();
  const anonymousOnBoards = useSetAnonymousOnForeignBoards();
  const enabled = settings.data?.enabled === true;
  const requests = useIncomingFollowRequests(isAuthenticated && enabled);
  const analyticsPreference = useAnalyticsPreference();
  const analyticsRegionDefault = useAnalyticsRegionDefault();
  const sessionRecording = useSessionRecordingToggle();
  const [confirmingIsPrivate, setConfirmingIsPrivate] = useState<boolean | null>(null);
  const [confirmingAudience, setConfirmingAudience] = useState<PrivacyResourceAudience | null>(null);
  const [heldAnonymous, setHeldAnonymous] = useState<boolean | null>(null);
  // The account switch reads the server again before it writes; that read is
  // part of the write, so it locks the rows and its failure is a failed save.
  const [readingBeforeWrite, setReadingBeforeWrite] = useState(false);
  const [readBeforeWriteFailed, setReadBeforeWriteFailed] = useState(false);

  // Read after an await, so a check uses who is signed in now, not at the tap.
  const latestViewerId = useRef(viewerId);
  latestViewerId.current = viewerId;

  const writePending = update.isPending || anonymousOnBoards.isPending || readingBeforeWrite;
  const writeLocked = writePending || effectiveOffline;
  const saveFailed = update.isError || anonymousOnBoards.isError || readBeforeWriteFailed;
  const saveFailedMessage = t('privacy.saveFailed');

  useEffect(() => {
    if (saveFailed) AccessibilityInfo.announceForAccessibility(saveFailedMessage);
  }, [saveFailed, saveFailedMessage]);

  /**
   * A new write owns the status line: an earlier failure of any privacy write
   * clears, so the note always describes the latest write and a failure of this
   * one is announced afresh.
   */
  const startWrite = () => {
    update.reset();
    anonymousOnBoards.reset();
    setReadBeforeWriteFailed(false);
  };

  const captureViewer = (): ViewerScope => ({
    viewerId: latestViewerId.current,
    credentialGeneration: captureAuthCredentialGeneration(),
  });
  // A sign-out or account switch behind a dialog or a read must not let the
  // old answer write to the new account.
  const isViewerCurrent = (scope: ViewerScope) =>
    latestViewerId.current === scope.viewerId && isAuthCredentialGenerationCurrent(scope.credentialGeneration);
  const confirmForViewer = async (copy: PrivacyConfirmCopy, scope: ViewerScope): Promise<boolean> =>
    (await confirm(copy)) && isViewerCurrent(scope);

  /**
   * The server's settings as they are now. The cached copy can be minutes old,
   * and another phone may have narrowed the session default since; building the
   * account switch's write from it could widen that default again. `undefined`
   * when the read failed, or settled without data newer than the request.
   */
  const readFreshSettings = async (): Promise<PrivacySettings | undefined> => {
    const requestedAt = Date.now();
    try {
      const result = await settings.refetch();
      return result.status === 'success' && result.dataUpdatedAt >= requestedAt ? result.data : undefined;
    } catch {
      return undefined;
    }
  };

  // The value the climber picked is HELD from the tap until its write settles
  // (or its confirm is cancelled), and drawn in place of the server's. The native
  // switch and the iOS Picker keep their own state and only resync when the prop
  // changes, so the prop has to follow the tap at once and move back on a cancel
  // or a failed write. Waiting for the mutation's pending state is not enough: a
  // write that fails at once can settle before this screen ever sees it pending.
  // Clearing a hold is a reset, not a report of success, so it runs whatever
  // account is signed in by then. A change is reported only from the write's
  // success, which the write hook already refuses for a replaced account.
  const changePrivateAccount = async (nextIsPrivate: boolean) => {
    const saved = settings.data;
    if (!saved || writeLocked || nextIsPrivate === saved.isPrivate) return;
    hapticSelection();
    setConfirmingIsPrivate(nextIsPrivate);
    const scope = captureViewer();
    // What the confirm tells the climber about new sessions. The write opens
    // them no further than that, whatever the fresh read below says.
    const reopenSessions = accountSwitchReopensSessions(nextIsPrivate, saved.defaultSessionAudience);
    const confirmation = accountSwitchConfirmation(nextIsPrivate, saved.defaultSessionAudience, t);
    if (confirmation && !(await confirmForViewer(confirmation, scope))) {
      setConfirmingIsPrivate(null);
      return;
    }
    startWrite();
    setReadingBeforeWrite(true);
    const fresh = await readFreshSettings();
    setReadingBeforeWrite(false);
    if (!isViewerCurrent(scope)) {
      setConfirmingIsPrivate(null);
      return;
    }
    if (!fresh) {
      setReadBeforeWriteFailed(true);
      setConfirmingIsPrivate(null);
      return;
    }
    // Another phone already made this change: the page now shows it, and there
    // is nothing left to write.
    if (fresh.isPrivate === nextIsPrivate) {
      setConfirmingIsPrivate(null);
      return;
    }
    update.mutate(accountSwitchPayload(nextIsPrivate, fresh.defaultSessionAudience, { reopenSessions }), {
      onSuccess: () => trackSettingChanged(SETTINGS_PAGE, PRIVATE_ACCOUNT_ROW_KEY, nextIsPrivate),
      onSettled: () => setConfirmingIsPrivate(null),
    });
  };

  const selectSessionAudience = async (audienceKey: string) => {
    const saved = settings.data;
    if (!saved || writeLocked || !isDefaultSessionAudience(audienceKey)) return;
    if (audienceKey === saved.defaultSessionAudience) return;
    hapticSelection();
    // Held BEFORE awaiting the confirm, so a cancel is a real change back.
    setConfirmingAudience(audienceKey);
    const scope = captureViewer();
    const confirmation = sessionAudienceConfirmation(audienceKey, saved.defaultSessionAudience, saved.isPrivate, t);
    if (confirmation && !(await confirmForViewer(confirmation, scope))) {
      setConfirmingAudience(null);
      return;
    }
    startWrite();
    // The explicit choice alone: the account switch is never re-sent from here.
    update.mutate(
      { defaultSessionAudience: audienceKey },
      {
        onSuccess: () => trackSettingChanged(SETTINGS_PAGE, SESSION_DEFAULT_ROW_KEY, audienceKey),
        onSettled: () => setConfirmingAudience(null),
      },
    );
  };

  const model = withSettingTracking(
    buildPrivacyModel({
      t,
      signedIn: isAuthenticated,
      settings: isAuthenticated ? settings.data : undefined,
      settingsLoading: settings.isLoading || profileQuery.isLoading,
      // Settings are read per climber, so a failed profile read leaves them
      // disabled rather than failed: say so instead of showing an empty page.
      settingsLoadFailed: settings.isError || profileQuery.isError,
      offline: effectiveOffline,
      saveFailed,
      writePending,
      pendingUpdate: update.isPending ? update.variables : undefined,
      pendingAnonymous: heldAnonymous ?? (anonymousOnBoards.isPending ? anonymousOnBoards.variables : undefined),
      confirming: {
        isPrivate: confirmingIsPrivate ?? undefined,
        sessionAudience: confirmingAudience ?? undefined,
      },
      pendingRequestCount: requests.data?.length ?? 0,
      analytics: { preference: analyticsPreference, regionDefault: analyticsRegionDefault },
      sessionRecording,
      onRetry: () => {
        // A recovered profile starts the settings read on its own.
        if (profileQuery.isError || !viewerId) void profileQuery.refetch();
        if (viewerId) void settings.refetch();
      },
      onPrivateAccountChange: (next) => void changePrivateAccount(next),
      onSessionAudienceSelect: (audienceKey) => void selectSessionAudience(audienceKey),
      onAnonymousOnForeignBoardsChange: (next) => {
        if (writeLocked) return;
        hapticSelection();
        setHeldAnonymous(next);
        startWrite();
        anonymousOnBoards.mutate(next, { onSettled: () => setHeldAnonymous(null) });
      },
      onOpenFollowRequests: () => openPeople('request'),
      onOpenFollowers: () => openPeople('follower'),
      onReviewBoards: () => router.push('/boards/manage'),
      onAnalyticsChange: (next) => {
        hapticSelection();
        void decideAnalyticsConsent(
          next ? 'granted' : 'denied',
          Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        ).catch((error: unknown) => reportHandledError(error));
      },
      onSessionRecordingChange: (next) => {
        hapticSelection();
        sessionRecording.onValueChange(next);
      },
      onOpenPrivacyPolicy: () => void openExternalUrl(PRIVACY_POLICY_URL, 'privacy-settings'),
    }),
    SETTINGS_PAGE,
    { skipKeys: UNTRACKED_ROW_KEYS },
  );

  return <MoreForm model={model} />;
}
