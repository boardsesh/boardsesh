// "Add a spray wall", end to end (epic #5346, SW-09).
//
// Name it → photograph it → optionally mark its corners → upload → let the
// server suggest holds → correct them → pick how it lights up → publish. One route, not seven: the steps share
// state that must survive going back (`add-wall-machine.ts` is the transition
// table), and two of them — the anchors and the hold editor — are full-screen
// pan-and-pinch surfaces, which `docs/mobile-sheets-vs-routes.md` rule 3 puts on
// a route rather than in a sheet.
//
// Everything that can fail, fails into somewhere the climber can act:
//
//  - the camera says no               → the step stays put and says so
//  - the upload dies halfway          → "Try again" retries the UPLOAD, against
//                                       the wall that already exists
//  - this build cannot suggest holds  → straight into the editor, manual
//  - detection blows up               → same place, with a different sentence
//  - publish is refused               → the draft is still there; retry or leave
//
// And leaving mid-flow is not a failure at all: from the upload onwards the wall
// and its one draft version live on the server, so closing the app and coming
// back tomorrow finds the work waiting (`docs/spray-walls.md`, "One open draft
// per wall").
//
// The same flow builds a RESET (`resetOfWallUuid`). `resetSprayWall` clones the
// old wall's settings into a new, unfinished wall, so the run skips the meta
// step and rejoins at the photo like any resumed wall. Its first publish
// archives the old wall (`docs/spray-walls.md`, "Archive and reset").

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS, sprayHoldsReviewed, sprayWallPhotoPicked, sprayWallUploadFinished } from '@boardsesh/analytics';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import type { UserBoard, SprayDetectionCandidate } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { GymPickerSheet } from '../board-discovery/GymPickerSheet';
import { SprayCornerStep } from './SprayCornerStep';
import { SprayPhotoAdjustStep } from './SprayPhotoAdjustStep';
import {
  confirmDiscardSprayEdits,
  SprayHoldEditorScreen,
  type SprayEditorNotice,
  type SprayHoldSaveSummary,
} from '../outline-editor/SprayHoldEditorScreen';
import {
  BoardIdentityFields,
  BoardVisibilityFields,
  SectionLabel,
  SprayWallVisibilityField,
} from '../board-discovery/BoardMetaFields';
import { SPRAY_ANGLE_OPTIONS, useSprayWallBuilder } from '../board-discovery/use-spray-wall-builder';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { AngleBoardDiagram } from '../play-drawer/AngleBoardDiagram';
import { useTheme } from '../../providers/theme-provider';
import {
  ownHeaderRight,
  useHeaderActions,
  type HeaderLeadingAction,
  type HeaderTrailingAction,
} from '../../hooks/use-header-actions';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useConnectivityField } from '../../lib/connectivity/use-connectivity';
import { getConnectivitySnapshot, type ConnectivitySnapshot } from '../../lib/connectivity/connectivity-store';
import { classifySprayUploadFailure, sprayUploadNotice, type SprayUploadNotice } from './spray-upload-notice';
import { iosSystemColors } from '../../theme/ios-colors';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { addErrorBreadcrumb, reportError } from '../../lib/error-reporting';
import { openExternalUrl } from '../../lib/open-url';
import { buildHelpUrl } from '../../lib/help-url';
import {
  extractGraphqlCode,
  extractGraphqlMessage,
  sprayWallLifecycleRefusal,
} from '../../lib/graphql/extract-error-message';
import { sprayWallLifecycleMessage } from '../../lib/spray/spray-lifecycle-copy';
import { SPRAY_CAP_VALUES, sprayCapFromErrorCode, sprayCapMessage } from '../../lib/spray/spray-cap-copy';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import { activatePublishedSprayWall } from '../../lib/spray/activate-published-spray-wall';
import { DONE_EXIT_OFFER_MS, PostPublishStalledError, runPostPublishBind } from '../../lib/spray/post-publish-bind';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { fetchSprayWallResetSource, invalidateSprayWallRenderData } from '../../lib/spray/spray-wall-loader';
import { settleArchivedSprayWall } from '../../lib/spray/settle-archived-spray-wall';
import { prefetchSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import {
  fetchSprayWallVersions,
  useCreateSprayWall,
  useCreateSprayWallVersion,
  useDiscardSprayWallDraft,
  useMySprayWalls,
  useMySprayWallLifecycle,
  usePublishSprayWallVersion,
  useResetSprayWall,
  useUpdateSprayWallVisibility,
  type CreatedSprayWall,
} from '../../lib/spray/use-create-spray-wall';
import { uploadSprayWallPhoto } from '../../lib/spray/spray-wall-photo-upload';
import { wallCreatedEventProperties } from './wall-created-event';
import { SprayDetectionStep } from './SprayDetectionStep';
import { SprayWallLookStep } from './SprayWallLookStep';
import { useSprayWizardLeaveGuard } from './use-spray-wizard-leave-guard';
import { exitSprayWizard } from './exit-spray-wizard';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import {
  pickWallPhotoFromCamera,
  pickWallPhotoFromLibrary,
  renderWallPhotoEdit,
  rescalePoint,
} from '../../lib/spray/wall-photo';
import { discardLocalPhoto } from '../../lib/spray/discard-local-photo';
import { editCrops, editRotates, editsEqual, isIdentityEdit, type WallPhotoEdit } from '../../lib/spray/photo-edit';
import {
  addWallReducer,
  backLeavesFlow,
  initialAddWallState,
  isBusy,
  leaveCheckpoint,
  leaveDecision,
  leaveStillApplies,
  type AddWallStep,
  type EditorLeaveState,
  type CreatedWall,
  type CreatedWallDraft,
  type DetectionOutcome,
} from './add-wall-machine';
import { findResumableWall, planUploadRetry, resumeTargetFor, startOverPlan } from './resume-draft';
import { SPRAY_FORM_MAX_WIDTH, sprayFlowCoversScreen } from '../../lib/spray/spray-flow-presentation';

/** The angle list as `AngleSlider` takes it. Built once: it never changes. */
const sprayAngles: number[] = [...SPRAY_ANGLE_OPTIONS];

/** Widest the photo preview is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PREVIEW_WIDTH = 520;

/**
 * The bind's navigation, taken away from `useActivateBoard`: the wizard leaves
 * by itself once the bind has landed (`runPostPublishBind`), so that whether
 * the dismiss actually took can be watched and, failing that, retried.
 */
const LEAVE_AFTER_BIND = () => {};

/** The steps that get a "step N of M" counter — the ones a climber drives. */
const COUNTED_STEPS: readonly AddWallStep[] = ['meta', 'photo', 'anchors', 'review', 'look', 'publish'];
/** A reset never shows the meta step (its settings came from the wall it replaces), so it counts from the photo. */
const RESET_COUNTED_STEPS: readonly AddWallStep[] = ['photo', 'anchors', 'review', 'look', 'publish'];

/**
 * Reset refusals no retry can fix: the server will say the same thing again.
 * The resume step offers only the way back for these.
 */
const FINAL_RESET_REFUSALS: ReadonlySet<string> = new Set([
  'resetOwnerOnly',
  'archived',
  'resetSourceUnpublished',
  'archiveLimitReached',
]);

type SprayWallWizardScreenProps = {
  /** Which tab the flow dismisses back to once the wall is bound. */
  returnTo: BoardReturnTo;
  /**
   * The published wall this run replaces, or null for a brand new wall. Set,
   * the run builds that wall's reset clone instead of offering an unfinished
   * wall back.
   */
  resetOfWallUuid?: string | null;
  /** The unfinished wall a progress row or notification opened, if any. */
  wallUuid?: string;
  /** The draft version on `wallUuid` that row or notification points at. */
  versionId?: string;
};

/** Hoisted for `useConnectivityField`: a stable selector keeps one subscription. */
function selectConnectivityReason(snapshot: ConnectivitySnapshot): ConnectivitySnapshot['reason'] {
  return snapshot.reason;
}

export function SprayWallWizardScreen({
  returnTo,
  resetOfWallUuid = null,
  wallUuid,
  versionId,
}: SprayWallWizardScreenProps) {
  const countedSteps = resetOfWallUuid != null ? RESET_COUNTED_STEPS : COUNTED_STEPS;
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  // The photo is the step that decides how many holds the finder misses, so
  // the long version of the advice (with the why) is one tap away, in the
  // language the climber is reading.
  const language = i18n.resolvedLanguage ?? i18n.language;
  const openPhotoGuide = useCallback(() => {
    void openExternalUrl(buildHelpUrl('spray-walls', language), 'spray-wizard-photo-guide');
  }, [language]);

  /**
   * A cap refusal said in the climber's own language, with its number, ahead of
   * anything the server wrote.
   *
   * The wall cap and the version cap are both reachable by ordinary use, and both
   * come back as an English sentence from a resolver. Branching on
   * `extensions.code` — never on that sentence — is what lets the app say the
   * rule and the number instead of relaying a string nobody translated.
   */
  /** The sentence for a network-class upload failure; literal keys for the i18n linter. */
  const uploadNoticeMessage = useCallback(
    (notice: SprayUploadNotice): string => {
      if (notice === 'offlineMode') return t('sprayWizard.upload.offlineMode');
      if (notice === 'noSignal') return t('sprayWizard.upload.noSignal');
      return t('sprayWizard.upload.serverUnreachable');
    },
    [t],
  );
  const capOrServerMessage = useCallback(
    (error: unknown, fallback: string): string => {
      const cap = sprayCapFromErrorCode(extractGraphqlCode(error));
      if (cap) return sprayCapMessage(cap, t);
      const lifecycle = sprayWallLifecycleRefusal(error);
      if (lifecycle) return sprayWallLifecycleMessage(lifecycle, t);
      return extractGraphqlMessage(error) ?? fallback;
    },
    [t],
  );
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { width: windowWidth } = useWindowDimensions();
  // Launch-fixed, like the presentation it follows: an iPad's flow is a full-screen
  // cover however its window is later resized.
  const formColumnCapped = sprayFlowCoversScreen();
  const bottomInset = useWindowBottomInset();

  const builder = useSprayWallBuilder();
  const [state, dispatch] = useReducer(addWallReducer, undefined, initialAddWallState);
  // Offline mode, said on the photo step before an upload tries and fails
  // (#5960). Only `reason` is subscribed, not the whole connectivity snapshot.
  const connectivityReason = useConnectivityField(selectConnectivityReason);
  const offlineModeOn = sprayUploadNotice(connectivityReason) === 'offlineMode';
  const [pickerBusy, setPickerBusy] = useState(false);
  // Hosted here rather than inside `BoardIdentityFields` so the sheet is a
  // SIBLING of the ScrollView, exactly as it is in `BoardForm` — a sheet mounted
  // inside a scrolling parent inherits its clipping and its pan.
  const [gymPickerOpen, setGymPickerOpen] = useState(false);

  const createWall = useCreateSprayWall();
  const createVersion = useCreateSprayWallVersion();
  const publishVersion = usePublishSprayWallVersion();
  // `mutateAsync` is bound once by the MutationObserver; the mutation OBJECTS are
  // fresh literals on every render, so closing over the objects would rebuild
  // every callback below on each commit.
  const createWallAsync = createWall.mutateAsync;
  const createVersionAsync = createVersion.mutateAsync;
  const publishVersionAsync = publishVersion.mutateAsync;
  const updateVisibility = useUpdateSprayWallVisibility();
  const updateVisibilityAsync = updateVisibility.mutateAsync;

  // The camera is a property of the BINARY and of the DEVICE, not of this
  // bundle: SW-02 put the usage description in 2.6.0, and an iOS simulator has
  // no camera to open — a picker launched into it aborts the app. Both gates
  // live in `canPhotographWall`.
  const cameraAvailable = useMemo(() => canPhotographWall(Platform.OS), []);

  const discardDraft = useDiscardSprayWallDraft();
  const discardDraftAsync = discardDraft.mutateAsync;
  const resetWall = useResetSprayWall();
  const resetWallAsync = resetWall.mutateAsync;

  /**
   * The initial board row, kept for creation analytics.
   *
   * A ref and not machine state because it is a PAYLOAD rather than an identity:
   * the machine holds which wall this is (and must, so a retry cannot mint a
   * second one), while this is the board object to hand to the bind. It is
   * filled either by `createSprayWall` or, on a resumed wall, by the list the
   * resume check already fetched.
   */
  const boardRef = useRef<UserBoard | null>(null);

  /**
   * Whether the meta step ran in THIS run — i.e. whether `builder` was ever
   * filled in.
   *
   * A resumed wall rejoins at the photo or at the editor and skips `meta`
   * entirely, so the builder still holds its constructor defaults. They look
   * exactly like real answers (40 degrees, no gym, private), which is why the
   * analytics payload is told explicitly rather than left to guess: see
   * `wall-created-event.ts`. Set where the wall is actually created, so the
   * mid-flow `adopt` path — a wall this run DID create — keeps its real answers.
   */
  const metaRanHereRef = useRef(false);

  // A board the climber just built is theirs by construction, so `isLocalOnly`
  // skips the follow-and-download pass; `rethrow` keeps the failure in this
  // screen's own inline error, because the toast overlay draws behind this modal
  // route; the publish tap already buzzed.
  const finish = useActivateBoard({
    returnTo,
    navigate: LEAVE_AFTER_BIND,
    isLocalOnly: true,
    writeFailure: 'rethrow',
    haptic: false,
  });

  /**
   * Out of the flow, back onto the tab the Boards modal was opened from. The
   * first road, taken once the bind has landed: a POP_TO onto the tab, which
   * is what every other board picker does (`useActivateBoard`).
   */
  const leaveToReturnTo = useCallback(() => {
    try {
      router.dismissTo(returnTo);
    } catch (error) {
      reportError(error);
    }
  }, [router, returnTo]);

  /**
   * The second road, for when the first did not land and for the `done`
   * step's own button. Re-sending the same `dismissTo` would fail the same way
   * — a POP_TO to a tab that is not in the history, say — so this closes the
   * Boards modal itself: `navigation` is the boards stack, and its parent is
   * the root stack the modal sits on. A modal with nothing under it (a cold
   * deep link) has nowhere to go back to, and only then is it replaced with
   * the tab; replacing while the tabs ARE underneath would stack a second tab
   * tree over them. At `done` the leave guard lets either straight through
   * (`leaveDecision`).
   */
  const closeBoardsModal = useCallback(() => {
    try {
      const rootNavigation = navigation.getParent();
      if (rootNavigation?.canGoBack()) {
        rootNavigation.goBack();
        return;
      }
      router.replace(returnTo);
    } catch (error) {
      reportError(error);
    }
  }, [navigation, router, returnTo]);

  /**
   * The bind attempt in flight. Aborted when a newer one starts and when the
   * screen unmounts: that clears its timers, and it is what stops a late answer
   * from a run that already gave up from starting a bind or navigating.
   */
  const bindControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => bindControllerRef.current?.abort(), []);

  const previewWidth = Math.min(MAX_PREVIEW_WIDTH, windowWidth - spacing[4] * 2);

  // ============================================
  // Step 0 — is there a wall to pick up?
  // ============================================

  // Only while the flow is actually asking. Once it has an answer the query is
  // dead weight, and refetching it mid-flow could offer to resume the very wall
  // this run just created.
  // A reset never asks: `resetSprayWall` hands back the clone to work on. A
  // targeted open never asks either: it already names the wall.
  const mySprayWalls = useMySprayWalls({
    enabled: state.step === 'resuming' && resetOfWallUuid == null && !wallUuid,
  });
  // `refetch` comes out with the rest of the fields on purpose. React Query keeps
  // it stable for the query's life, where the RESULT object is a fresh reference
  // on every render — so a callback closing over the whole thing would be rebuilt
  // on every commit, including each one an upload progress tick causes.
  const { isFetching: wallsFetching, dataUpdatedAt, errorUpdatedAt, refetch: refetchMySprayWalls } = mySprayWalls;
  const walls = mySprayWalls.data;
  // Which of those walls are a reset's unfinished clone: those are finished from
  // their own reset, never offered as a new wall. From the fail-soft lifecycle
  // list, since the full wall payload no longer carries the reset fields; on a
  // backend without them this fails, nothing is filtered, and the check behaves
  // as it always did.
  const sprayWallLifecycle = useMySprayWallLifecycle({
    enabled: state.step === 'resuming' && resetOfWallUuid == null && !wallUuid,
  });
  const lifecycleSettled = !sprayWallLifecycle.isFetching;
  const lifecycleRows = sprayWallLifecycle.data;
  /**
   * When this screen opened.
   *
   * The list has to be FRESH, not merely present. React Query serves a cached
   * value while it refetches, so on a same-device reopen `isPending` is already
   * false and `data` is the list from BEFORE this device created a wall — empty.
   * Deciding on that latches the prompt away and lets the flow create a second
   * wall beside the first, which is the orphan this check exists to prevent. So
   * the answer is only read once a fetch that STARTED after this mount has
   * settled.
   */
  const mountedAtRef = useRef(Date.now());
  const settledAt = Math.max(dataUpdatedAt, errorUpdatedAt);
  const wallsSettled = !wallsFetching && settledAt > mountedAtRef.current;
  // The prompt is a one-shot: an Alert that re-presented on a re-render would
  // stack copies of itself over the screen.
  const resumeAskedRef = useRef(false);

  const [resumeError, setResumeError] = useState<string | null>(null);
  // A reset refusal that "Try again" cannot fix (owner only, archived, …).
  const [resumeErrorIsFinal, setResumeErrorIsFinal] = useState(false);
  // For answers that land after the screen has gone: no alert over whatever the
  // climber moved on to, and no state update on an unmounted screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // One reset request at a time: two fast "Try again" taps must not send two
  // `resetSprayWall` calls or stack two prompts.
  const resetInFlightRef = useRef(false);

  // A targeted open (progress row, notification) whose wall or draft has gone:
  // asking again cannot bring it back, so only Back is offered.
  const showTargetUnavailable = useCallback(() => {
    setResumeError(t('sprayImport.unavailable'));
    setResumeErrorIsFinal(true);
  }, [t]);

  const decideResume = useCallback(
    async (
      resumable: NonNullable<ReturnType<typeof findResumableWall>>,
      choice: 'resume' | 'startOver',
      loaded?: NonNullable<Awaited<ReturnType<typeof fetchSprayWallVersions>>>,
    ) => {
      // The list carries no version history, so the draft — and whether it has a
      // photo — takes one more round trip. A FAILURE here is not "no draft":
      // treating it as one sends the climber to the photo step, where
      // `createSprayWallVersion` then refuses every upload forever because the
      // draft it could not see is still open. So it surfaces and offers a retry.
      const full = loaded ?? (await fetchSprayWallVersions(resumable.uuid).catch(() => null));
      if (!full) {
        setResumeError(t('sprayWizard.resume.checkFailed'));
        resumeAskedRef.current = false;
        return;
      }
      if (wallUuid && (!full.viewerCanEdit || full.uuid !== wallUuid)) {
        showTargetUnavailable();
        return;
      }
      if (wallUuid && full.currentVersion) {
        await finish(full.board);
        return;
      }
      if (
        versionId &&
        !full.versions?.some((version) => version.id === versionId && version.status.toLowerCase() === 'draft')
      ) {
        showTargetUnavailable();
        return;
      }
      if (full.board) boardRef.current = full.board;

      if (choice === 'startOver') {
        const plan = startOverPlan(resumable, full.versions ?? []);
        try {
          await discardDraftAsync({
            versionId: plan.discardVersionId,
            wallUuid: plan.deleteWallUuid,
            layoutId: full.layoutId,
          });
        } catch (error) {
          // Best-effort, deliberately. A start-over that cannot reach the server
          // must still let the climber build their wall; the stray row is what
          // the SW-17 cleanup job is for.
          reportError(error);
        }
        dispatch({ type: 'RESUME_DECLINED' });
        return;
      }

      const target = resumeTargetFor(resumable, full.versions ?? []);
      if (target.at === 'review') {
        dispatch({ type: 'RESUMED_AT_REVIEW', draft: target.draft, savedHoldCount: target.savedHoldCount });
        if (target.savedHoldCount === 0) dispatch({ type: 'DETECTION_STARTED' });
      } else {
        dispatch({ type: 'RESUMED_AT_PHOTO', wall: target.wall });
      }
    },
    [discardDraftAsync, t, wallUuid, versionId, finish, showTargetUnavailable],
  );

  const [targetAttempt, setTargetAttempt] = useState(0);
  useEffect(() => {
    if (resetOfWallUuid != null || !wallUuid || state.step !== 'resuming') return;
    let cancelled = false;
    void fetchSprayWallVersions(wallUuid)
      .then(async (target) => {
        if (cancelled) return;
        if (!target) {
          showTargetUnavailable();
          return;
        }
        await decideResume(target, 'resume', target);
      })
      .catch(() => {
        if (!cancelled) setResumeError(t('sprayWizard.resume.checkFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [resetOfWallUuid, wallUuid, state.step, targetAttempt, decideResume, showTargetUnavailable, t]);

  useEffect(() => {
    if (resetOfWallUuid != null || wallUuid) return;
    if (state.step !== 'resuming' || !wallsSettled || !lifecycleSettled || resumeAskedRef.current) return;
    resumeAskedRef.current = true;

    // A failed list is not a reason to block: the worst case is one extra wall
    // against the cap, and refusing to let somebody add a wall because we could
    // not check for an old one is far worse.
    const cloneOf = new Map((lifecycleRows ?? []).map((row) => [row.uuid, row.resetOfWallUuid ?? null]));
    const resumable = walls
      ? findResumableWall(walls.map((wall) => ({ ...wall, resetOfWallUuid: cloneOf.get(wall.uuid) ?? null })))
      : null;
    if (!resumable) {
      dispatch({ type: 'RESUME_DECLINED' });
      return;
    }

    const askToResume = () =>
      Alert.alert(t('sprayWizard.resume.title'), t('sprayWizard.resume.body', { name: resumable.board.name }), [
        {
          text: t('sprayWizard.resume.startOver'),
          style: 'destructive',
          onPress: () => void decideResume(resumable, 'startOver'),
        },
        { text: t('sprayWizard.resume.pickUp'), onPress: () => void decideResume(resumable, 'resume') },
      ]);
    if (cloneOf.has(resumable.uuid)) {
      askToResume();
      return;
    }
    // The list did not answer for this wall (it failed, or predates it). A
    // reset's clone offered here would publish through the plain path, leaving
    // the wall it replaces unsettled, so ask about this one wall before offering
    // it. A read that fails too offers it, as the check always did.
    void fetchSprayWallResetSource(resumable.uuid).then((resetOf) => {
      if (!mountedRef.current) return;
      if (resetOf) {
        dispatch({ type: 'RESUME_DECLINED' });
        return;
      }
      askToResume();
    });
  }, [resetOfWallUuid, wallUuid, state.step, wallsSettled, lifecycleSettled, lifecycleRows, walls, decideResume, t]);

  // ============================================
  // Step 0, for a reset — the clone to work on
  // ============================================

  /**
   * Get the reset's clone and rejoin it where it stands.
   *
   * `resetSprayWall` is idempotent: while a clone is unfinished it returns that
   * clone, so opening the reset again tomorrow lands on yesterday's photo. A
   * clone with a photo draft asks first, like any unfinished wall; "Start over"
   * deletes the CLONE (never the wall it replaces, which stays live) and starts
   * a fresh one.
   */
  const startReset = useCallback(async () => {
    if (resetOfWallUuid == null || resetInFlightRef.current) return;
    resetInFlightRef.current = true;
    setResumeError(null);
    setResumeErrorIsFinal(false);
    let fetched: CreatedSprayWall | null;
    try {
      const created = await resetWallAsync(resetOfWallUuid);
      boardRef.current = created.board;
      fetched = await fetchSprayWallVersions(created.uuid);
    } catch (error) {
      resetInFlightRef.current = false;
      if (!mountedRef.current) return;
      // The latch stays set: only "Try again" asks the server once more, so a
      // refusal no retry can fix is never re-sent behind the climber's back.
      const refusal = sprayWallLifecycleRefusal(error);
      if (!refusal) reportError(error);
      setResumeErrorIsFinal(refusal != null && FINAL_RESET_REFUSALS.has(refusal));
      setResumeError(refusal ? sprayWallLifecycleMessage(refusal, t) : t('sprayWizard.reset.startFailed'));
      return;
    }
    resetInFlightRef.current = false;
    if (!mountedRef.current) return;
    if (!fetched) {
      setResumeError(t('sprayWizard.reset.startFailed'));
      return;
    }
    const clone = fetched;
    if (clone.board) boardRef.current = clone.board;
    const versions = clone.versions ?? [];
    const target = resumeTargetFor(clone, versions);
    if (target.at === 'photo') {
      dispatch({ type: 'RESUMED_AT_PHOTO', wall: target.wall });
      return;
    }
    const pickUp = () => {
      if (!mountedRef.current) return;
      dispatch({ type: 'RESUMED_AT_REVIEW', draft: target.draft, savedHoldCount: target.savedHoldCount });
      if (target.savedHoldCount === 0) dispatch({ type: 'DETECTION_STARTED' });
    };
    const startOver = async () => {
      const plan = startOverPlan(clone, versions);
      try {
        await discardDraftAsync({
          versionId: plan.discardVersionId,
          wallUuid: plan.deleteWallUuid,
          layoutId: clone.layoutId,
        });
      } catch (error) {
        // Best-effort, as for a new wall: the next reset call returns the clone
        // that survived, and the prompt comes back.
        reportError(error);
      }
      if (mountedRef.current) void startResetRef.current();
    };
    Alert.alert(t('sprayWizard.reset.resumeTitle'), t('sprayWizard.reset.resumeBody', { name: clone.board.name }), [
      { text: t('sprayWizard.resume.startOver'), style: 'destructive', onPress: () => void startOver() },
      { text: t('sprayWizard.resume.pickUp'), onPress: pickUp },
    ]);
  }, [resetOfWallUuid, resetWallAsync, discardDraftAsync, t]);
  const startResetRef = useRef(startReset);
  startResetRef.current = startReset;

  useEffect(() => {
    if (resetOfWallUuid == null || state.step !== 'resuming' || resumeAskedRef.current) return;
    resumeAskedRef.current = true;
    void startReset();
  }, [resetOfWallUuid, state.step, startReset]);

  /** Ask again after a version-history request (or, for a reset, the reset itself) failed. */
  const retryResume = useCallback(() => {
    setResumeError(null);
    if (resetOfWallUuid != null) {
      resumeAskedRef.current = true;
      void startReset();
      return;
    }
    resumeAskedRef.current = false;
    mountedAtRef.current = Date.now();
    if (wallUuid) setTargetAttempt((attempt) => attempt + 1);
    else void refetchMySprayWalls();
  }, [resetOfWallUuid, startReset, refetchMySprayWalls, wallUuid]);

  // ============================================
  // Step 2 — the photo
  // ============================================

  const pickPhoto = useCallback(
    async (source: 'library' | 'camera') => {
      if (pickerBusy) return;
      setPickerBusy(true);
      hapticSelection();
      try {
        const result = source === 'camera' ? await pickWallPhotoFromCamera() : await pickWallPhotoFromLibrary();
        // Only the camera can be refused; the library picker needs no permission.
        if (result.outcome === 'denied') {
          showToast(t('sprayWizard.photo.cameraDenied'), 'warning');
          return;
        }
        if (result.outcome === 'cancelled') return;
        trackSprayEvent(sprayWallPhotoPicked(source));
        dispatch({ type: 'PHOTO_PICKED', photo: { ...result.photo, source } });
      } catch (error) {
        reportError(error);
        showToast(t('sprayWizard.photo.failed'), 'error');
      } finally {
        setPickerBusy(false);
      }
    },
    [pickerBusy, showToast, t],
  );

  // ============================================
  // Step 2, detour — crop or rotate
  // ============================================

  // The last render failed. Local rather than machine state: it is copy on the
  // crop step, and the machine's own answer to a failure is to stay put.
  const [adjustFailed, setAdjustFailed] = useState(false);

  const openAdjust = useCallback(() => {
    setAdjustFailed(false);
    dispatch({ type: 'ADJUST_OPENED' });
  }, []);

  const applyPhotoEdit = useCallback(
    async (edit: WallPhotoEdit) => {
      const photo = state.photo;
      if (!photo || state.photoProcessing) return;
      setAdjustFailed(false);
      // Done with nothing changed is Cancel: re-rendering the same file would
      // clear corners the climber has no reason to mark again.
      if (editsEqual(photo.edit, edit)) {
        dispatch({ type: 'BACK' });
        return;
      }
      dispatch({ type: 'PHOTO_PROCESSING_STARTED' });
      try {
        const rendered = await renderWallPhotoEdit(photo, edit);
        dispatch({
          type: 'PHOTO_ADJUSTED',
          photo: { ...photo, ...rendered, edit: isIdentityEdit(edit) ? null : edit },
        });
        // The edit this one replaced is nobody's now. Never the base, which
        // the next re-edit starts from, nor the picker's original.
        if (photo.uri !== photo.base.uri && photo.uri !== rendered.uri) discardLocalPhoto(photo.uri);
      } catch (error) {
        reportError(error);
        setAdjustFailed(true);
        dispatch({ type: 'PHOTO_PROCESSING_FAILED' });
      }
    },
    [state.photo, state.photoProcessing],
  );

  // ============================================
  // Steps 4 and 5 — upload, then suggest
  // ============================================

  const runDetection = useCallback(() => dispatch({ type: 'DETECTION_STARTED' }), []);
  const detectionCompleted = useCallback((candidates: SprayDetectionCandidate[]) => {
    dispatch({ type: 'DETECTION_FINISHED', candidates });
  }, []);
  const useManualEditor = useCallback(() => dispatch({ type: 'DETECTION_UNAVAILABLE' }), []);

  const runUpload = useCallback(async () => {
    const photo = state.photo;
    if (!photo || state.upload.running) return;
    // A wall that already has a draft has already had a photo adopted onto it,
    // and `createSprayWallVersion` refuses a second while one is open. Re-running
    // the upload from here would spend the photo and then fail on a rule the
    // climber cannot see; the way on from a draft is detection, not upload.
    if (state.draft) return;
    // Only needed when there is no wall yet. A resumed wall already carries its
    // name, angle and requested visibility on the server, so the meta step never
    // ran.
    const input = state.wall ? null : builder.buildCreateInput();
    if (!state.wall && !input) return;

    dispatch({ type: 'UPLOAD_STARTED' });
    const startedAt = Date.now();
    const attempt = state.upload.attempts + 1;
    try {
      // The wall first: the upload handler authorises the photo against a wall
      // the caller owns, so there is no order in which the photo could go first.
      let wall: CreatedWall | null = state.wall;
      // A retry against a wall that already exists has to ask what happened last
      // time. `createSprayWallVersion` can COMMIT and still lose its response —
      // the client then believes no draft exists, re-uploads, and is refused by
      // the one-open-draft rule on every attempt from then on. Adopting the
      // draft that is already there costs one query and ends that loop; it also
      // spares the private bucket a second copy of the same photo.
      if (wall && state.upload.attempts > 0) {
        // `createSprayWallVersion` can commit and still lose its response, so a
        // retry asks what the wall really has before spending the photo again.
        // `planUploadRetry` owns all three answers, including the one that took a
        // review to find: a read that FAILED is not "there is no draft".
        const existing = await fetchSprayWallVersions(wall.wallUuid).catch(() => null);
        const plan = planUploadRetry(existing, state.upload.attempts);
        if (plan.action === 'blocked') {
          dispatch({ type: 'UPLOAD_FAILED', message: t('sprayWizard.upload.checkFailed') });
          return;
        }
        if (plan.action === 'adopt') {
          // Straight to the editor, with no second detector pass: the photo was
          // already adopted, and the candidates from the first attempt are gone.
          dispatch({ type: 'RESUMED_AT_REVIEW', draft: plan.draft, savedHoldCount: plan.savedHoldCount });
          if (plan.savedHoldCount === 0) runDetection();
          return;
        }
      }
      if (!wall) {
        // `input` is non-null here — the guard above returns when both are.
        const created = await createWallAsync(input!);
        wall = { wallUuid: created.uuid, layoutId: created.layoutId, viewerCanEdit: created.viewerCanEdit };
        boardRef.current = created.board;
        metaRanHereRef.current = true;
        // Recorded BEFORE the upload, so a failure here still leaves the flow
        // pointing at the wall that exists rather than minting another on retry.
        dispatch({ type: 'WALL_CREATED', wall });
      }

      const uploaded = await uploadSprayWallPhoto({
        wallUuid: wall.wallUuid,
        uri: photo.uri,
        onProgress: (progress) => dispatch({ type: 'UPLOAD_PROGRESS', progress }),
      });
      trackSprayEvent(
        sprayWallUploadFinished({
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
          determinate: uploaded.determinate,
          attempt,
          cropped: editCrops(photo.edit),
          rotated: editRotates(photo.edit),
        }),
      );

      const stored = { width: uploaded.width, height: uploaded.height };
      // The anchors were tapped on the LOCAL file. The stored object is the
      // server's own re-encode of it, so the quad is carried across by the same
      // ratio the candidates are.
      const anchors = state.anchors
        ? state.anchors.map((point) => rescalePoint(point, { width: photo.width, height: photo.height }, stored))
        : null;

      const version = await createVersionAsync({ wallUuid: wall.wallUuid, photoId: uploaded.photoId, anchors });
      const draft: CreatedWallDraft = { ...wall, versionId: version.id, versionNumber: version.number };
      dispatch({ type: 'DRAFT_CREATED', draft });
      runDetection();
    } catch (error) {
      reportError(error);
      trackSprayEvent(
        sprayWallUploadFinished({
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          determinate: false,
          attempt,
          cropped: editCrops(photo.edit),
          rotated: editRotates(photo.edit),
        }),
      );
      // Classified now, at failure time, and stored with the message: a server
      // refusal (the wall cap) keeps its own words however connectivity moves
      // afterwards, and only a request that never got an answer is blamed on
      // the network (#5960).
      const notice = classifySprayUploadFailure(error, getConnectivitySnapshot().reason);
      dispatch({
        type: 'UPLOAD_FAILED',
        message: notice ? uploadNoticeMessage(notice) : capOrServerMessage(error, t('sprayWizard.upload.failed')),
      });
    }
  }, [
    state.photo,
    state.anchors,
    state.wall,
    state.draft,
    state.upload.running,
    state.upload.attempts,
    builder,
    createWallAsync,
    createVersionAsync,
    runDetection,
    capOrServerMessage,
    uploadNoticeMessage,
    t,
  ]);

  /**
   * What "Try again" does on the upload step.
   *
   * Two different failures land on the same screen. Without a draft the photo
   * never reached a version, so the upload is retried. WITH one the photo did
   * land — only the suggestion pass failed — and the way on is the editor.
   */
  const retryUpload = useCallback(() => {
    if (state.draft) {
      dispatch({ type: 'DETECTION_UNAVAILABLE' });
      return;
    }
    void runUpload();
  }, [state.draft, runUpload]);

  // Entering the upload step with nothing in flight and no error to acknowledge
  // starts it. An effect rather than a call from the anchors CTA, so that both
  // ways in — "Use these corners" and "Skip" — behave identically.
  useEffect(() => {
    if (state.step !== 'upload') return;
    if (state.upload.running || state.upload.error || state.upload.attempts > 0) return;
    void runUpload();
  }, [state.step, state.upload.running, state.upload.error, state.upload.attempts, runUpload]);

  // The editor reads the draft the moment detection hands over. Starting that
  // read while the detector runs means it usually opens with its wall in hand.
  const detectDraft = state.step === 'detect' ? state.draft : null;
  useEffect(() => {
    if (!detectDraft) return;
    void prefetchSprayWallDraft(
      queryClient,
      detectDraft.layoutId,
      detectDraft.wallUuid,
      detectDraft.versionNumber,
      detectDraft.versionId,
    );
  }, [detectDraft, queryClient]);

  // ============================================
  // Step 7 — publish, bind, leave
  // ============================================

  const publish = useCallback(async () => {
    const { draft, wall, published } = state;
    const board = boardRef.current;
    if (!draft || !wall || state.publish.running) return;
    bindControllerRef.current?.abort();
    const bindController = new AbortController();
    bindControllerRef.current = bindController;
    dispatch({ type: 'PUBLISH_STARTED' });
    hapticSelection();
    // The look step just saved; this is the next thing that happens, and the
    // spinner's own live region only speaks on Android.
    AccessibilityInfo.announceForAccessibility(t('sprayWizard.publish.working'));
    try {
      // Skipped once the version is already published. Publishing and binding
      // the wall as the active board are two writes behind one button, and
      // `publishSprayWallVersion` refuses a version that has already landed — so
      // a retry that re-ran both would turn a failed bind into a dead end.
      // The visibility the climber chose in THIS run's meta step. The server
      // already holds it from `createSprayWall` and the publish applies it
      // (#5513) — which is what covers a resumed run, where this is null because
      // the builder never saw the meta step. The write below re-states it for a
      // backend that predates that. Read up here because the analytics payload
      // needs it too — it is what the wall is ABOUT to be.
      const visibility = builder.pendingVisibility();

      if (!published) {
        await publishVersionAsync(draft.versionId);
        // Latched before anything else can throw: past this point a failure
        // must retry the bind, never the publish the server would now refuse.
        dispatch({ type: 'PUBLISHED' });
        // This publish archived the wall the reset replaces. Say so on this
        // device now, rather than when its registration next revalidates.
        if (resetOfWallUuid != null) settleArchivedSprayWall(queryClient, resetOfWallUuid, draft.wallUuid);
        // Built from the wall itself, not from `builder`: a resumed run never ran
        // the meta step, so the builder's fields are its constructor defaults and
        // reporting them would bias this funnel for every wall finished on a
        // second sitting. `wall-created-event.ts` carries the whole rule.
        // Once per wall, here and nowhere else; and caught, so a builder that
        // throws costs the event rather than the bind.
        try {
          track(
            SHARED_EVENTS.BoardCreated,
            wallCreatedEventProperties({
              layoutId: wall.layoutId,
              board,
              meta: metaRanHereRef.current
                ? {
                    angle: builder.angle,
                    hasLocationName: builder.locationName.trim().length > 0,
                    hasCoords: builder.coords != null,
                    gymUuid: builder.selectedGym?.uuid ?? null,
                  }
                : null,
              pendingVisibility: visibility,
              isReset: resetOfWallUuid != null,
            }),
          );
        } catch (error) {
          reportError(error);
        }
      } else {
        // A retry: the re-bind runs on `done`, exactly like the first.
        dispatch({ type: 'PUBLISHED' });
      }

      await runPostPublishBind({
        // Register the PUBLISHED generation right now. SW-07's revalidation
        // window would get there eventually, but the device that published
        // already knows the version moved — and until it re-registers, every
        // spray cache key still names the draft the climber was editing. Not
        // waited on: it is a cache invalidation, and a live subscriber's
        // refetch can pause under `offlineFirst` for as long as the app thinks
        // it is offline.
        refresh: () => invalidateSprayWallRenderData(queryClient, draft.wallUuid, draft.layoutId),
        // Idempotent, and after the latch above, so a retry of a failed bind
        // re-applies it rather than re-publishing.
        updateVisibility: visibility ? () => updateVisibilityAsync({ uuid: draft.wallUuid, ...visibility }) : null,
        // Fetch the published visibility before persisting the active board.
        // A failed read leaves the published latch set, so retry only binds.
        activate: (hooks) => activatePublishedSprayWall(queryClient, draft.wallUuid, finish, hooks),
        navigate: leaveToReturnTo,
        fallbackNavigate: closeBoardsModal,
        signal: bindController.signal,
      });
    } catch (error) {
      // Unmounted, or superseded by a newer attempt: nobody is left to tell.
      if (bindController.signal.aborted) return;
      if (error instanceof PostPublishStalledError) {
        // Already reported, with its stage, by the run that called it.
        dispatch({ type: 'PUBLISH_FAILED', message: t('sprayWizard.publish.stalled') });
        return;
      }
      reportError(error);
      dispatch({ type: 'PUBLISH_FAILED', message: capOrServerMessage(error, t('sprayWizard.publish.failed')) });
    }
  }, [
    state,
    publishVersionAsync,
    updateVisibilityAsync,
    queryClient,
    builder,
    finish,
    leaveToReturnTo,
    closeBoardsModal,
    resetOfWallUuid,
    t,
  ]);

  /**
   * The `done` step's own way out, offered once the bind has had long enough
   * that something is wrong. The wall is published and in Your boards whatever
   * happens next, so leaving here loses nothing; a bind not yet started is
   * dropped with the screen (`bindControllerRef`) rather than flipping the
   * active board later under whatever the climber has moved on to. It takes
   * the second road out, because the first may be the one that did not land.
   */
  const [doneExitOffered, setDoneExitOffered] = useState(false);
  useEffect(() => {
    // Not reset when the step moves on: a retry that lands back here after a
    // failed bind offers the way out straight away, which is right for a
    // climber who has already waited once.
    if (state.step !== 'done') return;
    const timer = setTimeout(() => setDoneExitOffered(true), DONE_EXIT_OFFER_MS);
    return () => clearTimeout(timer);
  }, [state.step]);
  const leaveFromDone = useCallback(() => {
    addErrorBreadcrumb({ category: 'spray-wall.bind', message: 'done_exit_tapped', level: 'info' });
    closeBoardsModal();
  }, [closeBoardsModal]);

  /**
   * Publish runs by itself the moment the look step confirms — its button is
   * the last one, and a further screen asking to publish again would be the
   * three-commit flow this replaced. Once per draft: a failure stays on the
   * publish step with its error and Retry, and never re-fires on its own.
   */
  const autoPublishedVersionRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.step !== 'publish' || !state.draft) return;
    if (state.publish.running || state.publish.error) return;
    if (autoPublishedVersionRef.current === state.draft.versionId) return;
    autoPublishedVersionRef.current = state.draft.versionId;
    void publish();
  }, [state.step, state.draft, state.publish.running, state.publish.error, publish]);

  /**
   * What only the editor knows about leaving: whether it holds decisions it has
   * not written (`onDirtyChange`), and whether its commit is in flight or its
   * publish moment is playing (`onHandoverChange`). Refs: nothing renders on
   * them, and every way out reads them at the moment it is taken.
   */
  const editorDirtyRef = useRef(false);
  const editorHandingOverRef = useRef(false);
  const onEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
  }, []);
  const onEditorHandoverChange = useCallback((handingOver: boolean) => {
    editorHandingOverRef.current = handingOver;
  }, []);
  const readEditorLeaveState = useCallback(
    (): EditorLeaveState => ({ dirty: editorDirtyRef.current, handingOver: editorHandingOverRef.current }),
    [],
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Ask, then run `onConfirm` — or run it straight away when there is nothing to
   * ask about, or drop it when the editor is mid-hand-over (`leaveDecision`).
   *
   * The dialog's Leave re-checks the flow when it is pressed, not when it was
   * shown: a publish that started under the dialog must not be popped by an
   * answer given before it began.
   */
  const confirmLeave = useCallback(
    (onConfirm: () => void) => {
      const decision = leaveDecision(state, readEditorLeaveState());
      if (decision === 'block') return;
      if (decision === 'leave') {
        onConfirm();
        return;
      }
      const askedAt = leaveCheckpoint(state);
      const confirmed = () => {
        if (!leaveStillApplies(askedAt, stateRef.current, readEditorLeaveState())) return;
        onConfirm();
      };
      if (decision === 'confirmDiscard') {
        // Unwritten hold changes: the wall is kept, the changes are not, and the
        // dialog says exactly that.
        confirmDiscardSprayEdits(true, confirmed, {
          title: t('sprayWizard.leave.unsavedTitle'),
          message: t('sprayWizard.leave.unsavedBody'),
          keep: t('sprayWizard.leave.stay'),
          discard: t('sprayWizard.leave.discard'),
        });
        return;
      }
      Alert.alert(t('sprayWizard.leave.title'), t('sprayWizard.leave.body'), [
        { text: t('sprayWizard.leave.stay'), style: 'cancel' },
        { text: t('sprayWizard.leave.go'), onPress: confirmed },
      ]);
    },
    [state, t, readEditorLeaveState],
  );

  // Native dismissal is held while the existing decision and stale-answer
  // checks run. Always registered: editor dirtiness changes through refs.
  useSprayWizardLeaveGuard(confirmLeave);

  const goBack = useCallback(() => {
    if (isBusy(state)) return;
    // `review`, `look` and `publish` have no step behind them — the draft is on
    // the server by then — so back means leaving, which keeps the draft. A
    // reset's photo step has nothing behind it either: the clone's name and
    // angle came from the wall it replaces, so there is no meta step to return to.
    if (backLeavesFlow(state) || (resetOfWallUuid != null && state.step === 'photo')) {
      router.back();
      return;
    }
    dispatch({ type: 'BACK' });
  }, [state, router, resetOfWallUuid]);

  const candidateCount = state.detection.candidates.length;
  const onHoldsCommitted = useCallback(
    ({ written, removed, holdCount }: SprayHoldSaveSummary) => {
      // A resumed draft with nothing changed commits without writing; nothing
      // was reviewed, so nothing is reported.
      if (written > 0 || removed > 0) {
        trackSprayEvent(sprayHoldsReviewed({ holdCount: written, candidateCount, hadCandidates: candidateCount > 0 }));
      }
      editorDirtyRef.current = false;
      dispatch({ type: 'REVIEW_COMMITTED', holdCount });
    },
    [candidateCount],
  );

  const onLookSaveStarted = useCallback(() => dispatch({ type: 'LOOK_SAVE_STARTED' }), []);
  const onLookSaveFailed = useCallback(() => dispatch({ type: 'LOOK_SAVE_FAILED' }), []);
  const onLookConfirmed = useCallback(() => dispatch({ type: 'LOOK_CONFIRMED' }), []);

  const retryDetection = useCallback(() => dispatch({ type: 'DETECTION_STARTED' }), []);
  const reviewNotice = useMemo(
    () => reviewNoticeFor(state.detection.outcome, t, retryDetection),
    [state.detection.outcome, t, retryDetection],
  );

  // The rings sweep in only when a scan has just found some. A resumed draft's
  // stored holds, or an empty or failed scan, open without the show.
  const revealRings = state.detection.outcome === 'done' && state.detection.candidates.length > 0;

  // ============================================
  // The header: a way back or out, and the step's forward action
  // ============================================

  // The X the layout draws, with the same leave guard behind it: it goes back
  // through the history, which `useSprayWizardLeaveGuard` intercepts.
  const exitFlow = useCallback(() => exitSprayWizard(router, returnTo), [router, returnTo]);

  // Two steps draw their own header actions. The crop detour owns its edit, so
  // it sets Cancel and Done itself; the editor and the look step set their own
  // trailing confirm. The wizard leaves those slots alone.
  const childOwnsHeader = state.step === 'adjust' && state.photo != null;
  const childOwnsTrailing = (state.step === 'review' || state.step === 'look') && state.draft != null;

  // A back chevron where Back steps back inside the flow, an X where it would
  // leave (the first step, a reset's photo step, and everything from the draft
  // on). Passed on every step: the header keeps whatever was set last.
  const backStaysInFlow =
    (state.step === 'photo' || state.step === 'anchors' || state.step === 'upload') &&
    !backLeavesFlow(state) &&
    !(resetOfWallUuid != null && state.step === 'photo');
  // While a request runs, Back does nothing (`goBack` refuses), so the chevron
  // says so. With the chevron leading there is no X: a German "Überspringen"
  // beside it would not fit at 375 pt. Leaving from those steps is a swipe down
  // through the same leave guard, or back to step 1's X.
  const busy = isBusy(state);
  const headerLeading: HeaderLeadingAction | null = childOwnsHeader
    ? null
    : backStaysInFlow
      ? { kind: 'back', onPress: goBack, disabled: busy, accessibilityLabel: t('sprayWizard.back') }
      : { kind: 'close', onPress: exitFlow };

  const publishRunning = state.publish.running;
  let headerTrailing: HeaderTrailingAction | null = null;
  if (state.step === 'meta') {
    headerTrailing = {
      kind: 'forward',
      label: t('sprayWizard.meta.next'),
      onPress: () => dispatch({ type: 'META_DONE' }),
      disabled: !builder.canCreate,
      prominent: true,
    };
  } else if (state.step === 'photo') {
    headerTrailing = {
      kind: 'forward',
      label: t('sprayWizard.photo.next'),
      onPress: () => dispatch({ type: 'PHOTO_CONFIRMED' }),
      disabled: state.photo == null,
      prominent: true,
    };
  } else if (state.step === 'anchors' && state.photo) {
    // Skip while the rings are where they started, Next once one has moved. No
    // corners is a valid answer, so only a refused quad shuts the gate.
    headerTrailing = {
      kind: 'forward',
      label: state.anchors ? t('sprayWizard.anchors.next') : t('sprayWizard.anchors.skip'),
      onPress: () => dispatch({ type: 'ANCHORS_DONE' }),
      disabled: state.anchorRejection != null,
      prominent: true,
    };
  } else if (state.step === 'upload' && state.upload.error) {
    headerTrailing = { kind: 'forward', label: t('sprayWizard.upload.retry'), onPress: retryUpload, prominent: true };
  } else if (state.step === 'publish' && state.publish.error) {
    headerTrailing = {
      kind: 'forward',
      label: t('sprayWizard.publish.retry'),
      onPress: () => void publish(),
      loading: publishRunning,
      disabled: publishRunning,
      prominent: true,
    };
  } else if (state.step === 'done' && doneExitOffered) {
    headerTrailing = { kind: 'forward', label: t('sprayWizard.done.leave'), onPress: leaveFromDone, prominent: true };
  }

  useHeaderActions({
    leading: headerLeading,
    trailing: childOwnsTrailing ? null : headerTrailing,
  });

  // The hook never clears a slot, so a step with nothing on the right (the
  // upload running, the publish, the scan) clears the last step's action here.
  // Not on the steps whose own screen sets the right side.
  const clearHeaderRight = headerTrailing == null && !childOwnsHeader && !childOwnsTrailing;
  useLayoutEffect(() => {
    if (clearHeaderRight) navigation.setOptions(ownHeaderRight(undefined));
  }, [clearHeaderRight, navigation, state.step]);

  // The title only on the first step (and while the resume check runs). Past
  // it the body's "STEP N OF M" says where the climber is, and the bar's room
  // goes to the actions.
  const showsTitle = state.step === 'resuming' || state.step === countedSteps[0];
  const screenTitle = resetOfWallUuid != null ? t('sprayWizard.reset.screenTitle') : t('sprayWizard.screenTitle');
  useLayoutEffect(() => {
    navigation.setOptions({ title: showsTitle ? screenTitle : '' });
  }, [navigation, showsTitle, screenTitle]);

  // Android Back steps back inside the flow where the chevron would; anywhere
  // else it falls through to the stack, which the leave guard intercepts. Only
  // while this screen is focused, so a screen above it keeps its own Back.
  const hardwareBackRef = useRef<() => boolean>(() => false);
  // On the crop detour it is the header's Cancel (the same `goBack` the crop
  // step's Cancel calls), never a way out of the flow. A tap while busy is
  // swallowed: `goBack` refuses, and the stack must not pop either.
  hardwareBackRef.current = () => {
    if (!backStaysInFlow && state.step !== 'adjust') return false;
    goBack();
    return true;
  };
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => hardwareBackRef.current());
      return () => subscription.remove();
    }, []),
  );

  // ============================================
  // Render
  // ============================================

  // With the photo on this phone, the scan is a full-screen surface too: the
  // photo full-bleed where the editor will put it, so the rings land on the very
  // pixels the scan band was sweeping. A run resumed without the file keeps the
  // plain spinner inside the stepper below.
  if (state.step === 'detect' && state.draft && state.photo) {
    return (
      <SprayDetectionStep
        wallUuid={state.draft.wallUuid}
        versionId={state.draft.versionId}
        photo={state.photo}
        onComplete={detectionCompleted}
        onManual={useManualEditor}
      />
    );
  }

  // The editor is its own full-screen surface with its own floating bar and its
  // own Publish button. It gets the whole screen rather than being boxed into
  // the wizard's scroll view, which would put a second scroller around a
  // pinch-zoom board.
  if (state.step === 'review' && state.draft) {
    return (
      <SprayHoldEditorScreen
        wallUuid={state.draft.wallUuid}
        layoutId={state.draft.layoutId}
        versionId={state.draft.versionId}
        versionNumber={state.draft.versionNumber}
        viewerCanEdit={state.draft.viewerCanEdit}
        candidates={state.detection.candidates}
        revealOnMount={revealRings}
        primaryLabel={t('sprayWizard.review.next')}
        loadingPhoto={state.photo}
        notice={reviewNotice}
        onCommitted={onHoldsCommitted}
        onDirtyChange={onEditorDirtyChange}
        onHandoverChange={onEditorHandoverChange}
      />
    );
  }

  // The wall's look, on its own full-screen surface for the editor's reason: its
  // rail is a near-full-height horizontal swiper, and the wizard's vertical
  // scroll view around it would steal the swipes.
  if (state.step === 'look' && state.draft) {
    return (
      <SprayWallLookStep
        draft={state.draft}
        stepCounter={t('sprayWizard.stepCounter', {
          current: countedSteps.indexOf('look') + 1,
          total: countedSteps.length,
        })}
        onSaveStarted={onLookSaveStarted}
        onSaveFailed={onLookSaveFailed}
        onConfirmed={onLookConfirmed}
        // Said before the publish that does it, on every road in: a deep link
        // or a resumed reset never saw the confirm that explained it.
        notice={resetOfWallUuid != null ? t('sprayWizard.reset.archiveNotice') : undefined}
      />
    );
  }

  const stepIndex = countedSteps.indexOf(state.step);

  // The crop step is a screenful of its own for the corner step's reason: a
  // drag on the crop box must never also be a scroll. It is not counted — it
  // is a detour off the photo step, not a step of the flow.
  if (state.step === 'adjust' && state.photo) {
    return (
      <SprayPhotoAdjustStep
        title={t('sprayWizard.adjust.title')}
        body={t('sprayWizard.adjust.body')}
        photo={state.photo}
        processing={state.photoProcessing}
        failed={adjustFailed}
        onDone={(edit) => void applyPhotoEdit(edit)}
        onCancel={goBack}
      />
    );
  }

  // Its own screenful rather than a section of the scrolling page below: the
  // photo is fitted to the space under the header, so all four rings are on
  // screen and a vertical drag is never also a scroll (#5958). Back, Skip and
  // Next are in the header; "Start the corners again" sits with the photo.
  if (state.step === 'anchors' && state.photo) {
    return (
      <SprayCornerStep
        stepCounter={t('sprayWizard.stepCounter', { current: stepIndex + 1, total: countedSteps.length })}
        title={t('sprayWizard.anchors.title')}
        body={t('sprayWizard.anchors.body')}
        photo={state.photo}
        value={state.anchors}
        onChange={(quad) => dispatch({ type: 'ANCHORS_SET', anchors: quad })}
        invalid={state.anchorRejection != null}
        // A new wall's frame IS its first photo (version 1 defines it).
        qualityFrame={state.photo}
        canClear={state.anchors != null && !isBusy(state)}
        onClear={() => dispatch({ type: 'ANCHORS_CLEARED' })}
      />
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        // Nothing pinned under the page, so it pads only past the home
        // indicator. iOS adds that inset itself under `automatic`.
        contentContainerStyle={[
          styles.content,
          formColumnCapped ? styles.tabletContent : null,
          { paddingBottom: spacing[4] + (Platform.OS === 'ios' ? 0 : bottomInset) },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {stepIndex >= 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stepCounter}>
            {t('sprayWizard.stepCounter', { current: stepIndex + 1, total: countedSteps.length })}
          </Text>
        ) : null}

        {state.step === 'resuming' ? (
          <View style={styles.doneBlock}>
            {resumeError ? null : <ActivityIndicator />}
            <Text
              variant="subheadline"
              color={resumeError ? iosSystemColors.systemRed : systemColors.secondaryLabel}
              accessibilityLiveRegion="polite"
            >
              {resumeError ??
                (resetOfWallUuid != null ? t('sprayWizard.reset.starting') : t('sprayWizard.resume.checking'))}
            </Text>
            {resumeError && !resumeErrorIsFinal ? (
              <Button title={t('sprayWizard.resume.retry')} variant="filled" onPress={retryResume} />
            ) : null}
            {resumeError && (resetOfWallUuid != null || wallUuid) ? (
              <Button title={t('sprayWizard.back')} variant="text" onPress={closeBoardsModal} />
            ) : null}
          </View>
        ) : null}

        {state.step === 'meta' ? (
          <>
            <Text variant="title3">{t('sprayWizard.meta.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.meta.body')}
            </Text>

            <BoardIdentityFields
              builder={builder}
              namePlaceholder={t('sprayWizard.meta.namePlaceholder')}
              onOpenGymPicker={() => setGymPickerOpen(true)}
            />

            <SectionLabel>{t('sprayWizard.meta.angle')}</SectionLabel>
            {/* The shared list, snapped — not a free-text field. The server
                validates against `SPRAY_ANGLES`, so a typed 37 would walk the
                whole flow and only be refused at the upload, with the wall
                already created. The same slider and teaching diagram the board
                builder uses, so a wall's angle is picked the way every other
                board's is. */}
            <View style={styles.angleDiagram}>
              <AngleBoardDiagram
                angle={builder.angle}
                size={140}
                accessibilityLabel={t('sprayWizard.meta.anglePreview', { angle: builder.angle })}
              />
            </View>
            <AngleSlider angles={sprayAngles} value={builder.angle} onChange={builder.setAngle} />
            <Text variant="caption1" color={systemColors.tertiaryLabel}>
              {t('sprayWizard.meta.angleHint')}
            </Text>

            {/* Same three-way control as Edit board: two switches let "Public"
                and "Unlisted" both be on, and Unlisted had no hint (#5960). */}
            <SprayWallVisibilityField builder={builder} />
            <BoardVisibilityFields builder={builder} hideVisibilitySwitches />

            {/* The wall cap said before it bites rather than after: ten is a
                number a gym with a lot of bays can reach, and meeting it as a
                refusal on the publish step — with a photo already uploaded — is
                the worst moment to learn it. */}
            <Text variant="caption1" color={systemColors.tertiaryLabel}>
              {t('sprayCaps.wallsHint', { max: SPRAY_CAP_VALUES.walls })}
            </Text>
          </>
        ) : null}

        {state.step === 'photo' ? (
          <>
            <Text variant="title3">
              {resetOfWallUuid != null ? t('sprayWizard.reset.photoTitle') : t('sprayWizard.photo.title')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {resetOfWallUuid != null ? t('sprayWizard.reset.photoBody') : t('sprayWizard.photo.body')}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayWizard.photo.tip')}
            </Text>
            <Pressable
              onPress={openPhotoGuide}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={styles.photoGuideLink}
              accessibilityRole="link"
              accessibilityHint={t('sprayWizard.photo.helpLinkHint')}
            >
              <Text variant="subheadline" color={systemColors.accent}>
                {t('sprayWizard.photo.helpLink')}
              </Text>
            </Pressable>
            {/* Said before the upload, not after it fails: Offline mode is a
                switch the climber can turn off right now. */}
            {offlineModeOn ? (
              <Text variant="footnote" color={iosSystemColors.systemOrange} accessibilityLiveRegion="polite">
                {t('sprayWizard.upload.offlineMode')}
              </Text>
            ) : null}
            <View style={styles.photoActions}>
              <Button
                title={state.photo ? t('sprayWizard.photo.pickAnother') : t('sprayWizard.photo.library')}
                variant={state.photo ? 'text' : 'filled'}
                onPress={() => void pickPhoto('library')}
                disabled={pickerBusy}
              />
              {/* Only on a binary whose Info.plist declares the camera. On an
                  older one iOS does not deny the request, it terminates. */}
              {cameraAvailable ? (
                <Button
                  title={t('sprayWizard.photo.camera')}
                  variant="text"
                  onPress={() => void pickPhoto('camera')}
                  disabled={pickerBusy}
                />
              ) : null}
            </View>
            {state.photo ? (
              <View style={styles.previewWrap}>
                <Image
                  source={{ uri: state.photo.uri }}
                  style={{
                    width: previewWidth,
                    height: previewHeight(previewWidth, state.photo),
                    borderRadius: borderRadius.lg,
                  }}
                  contentFit="cover"
                  accessibilityIgnoresInvertColors
                />
                {/* Under the photo it changes. Crop happens before the upload, so
                    the server only ever sees the cropped file. */}
                <Button
                  title={t('sprayWizard.photo.adjust')}
                  icon="crop.free"
                  variant="text"
                  onPress={openAdjust}
                  disabled={pickerBusy}
                />
              </View>
            ) : null}
          </>
        ) : null}

        {state.step === 'upload' ? (
          <>
            <Text variant="title3">{t('sprayWizard.upload.title')}</Text>
            {state.upload.error ? (
              <Text variant="subheadline" color={iosSystemColors.systemRed} accessibilityLiveRegion="polite">
                {state.upload.error}
              </Text>
            ) : (
              <ProgressBlock
                label={
                  state.upload.progress == null
                    ? t('sprayWizard.upload.working')
                    : t('sprayWizard.upload.percent', { percent: Math.round(state.upload.progress * 100) })
                }
                progress={state.upload.progress}
              />
            )}
          </>
        ) : null}

        {state.step === 'detect' && state.draft ? (
          <SprayDetectionStep
            wallUuid={state.draft.wallUuid}
            versionId={state.draft.versionId}
            onComplete={detectionCompleted}
            onManual={useManualEditor}
          />
        ) : null}

        {state.step === 'publish' ? (
          <>
            <Text variant="title3">{t('sprayWizard.publish.title')}</Text>
            {state.publish.error ? (
              <Text variant="subheadline" color={iosSystemColors.systemRed} accessibilityLiveRegion="polite">
                {state.publish.error}
              </Text>
            ) : (
              <View style={styles.doneBlock}>
                <ActivityIndicator />
                <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
                  {t('sprayWizard.publish.working')}
                </Text>
              </View>
            )}
          </>
        ) : null}

        {state.step === 'done' ? (
          <View style={styles.doneBlock}>
            <ActivityIndicator />
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.done.body')}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {gymPickerOpen ? (
        <GymPickerSheet
          selectedUuid={builder.selectedGym?.uuid ?? null}
          boardCoords={builder.coords}
          showsOnMap={builder.isPublic}
          onSelect={(gym) => {
            builder.setSelectedGym(gym);
            setGymPickerOpen(false);
          }}
          onRequestManualLocation={() => {
            builder.setSelectedGym(null);
            setGymPickerOpen(false);
          }}
          onDismiss={() => setGymPickerOpen(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * How tall to draw the picked photo at `width`.
 *
 * A picker that could not report a size hands back zeros (`predictCompressedSize`
 * normalises anything worse to the same), and dividing by that aspect yields NaN
 * — which React Native takes as no height at all, so the photo the climber just
 * chose does not appear and nothing says why. Four-by-three is the fallback: it
 * is wrong for some photos and visible for all of them, which is the trade worth
 * making on a step whose whole job is showing the photo back.
 */
function previewHeight(width: number, photo: { width: number; height: number }): number {
  if (!(photo.width > 0) || !(photo.height > 0)) return (width * 3) / 4;
  return (width * photo.height) / photo.width;
}

/**
 * What the editor says over an empty wall, by how detection went. Shown only
 * while the wall has no rings at all, so a scan that found holds says nothing.
 */
function reviewNoticeFor(outcome: DetectionOutcome, t: (key: string) => string, retry: () => void): SprayEditorNotice {
  if (outcome === 'failed') {
    return {
      message: t('sprayWizard.review.detectionFailed'),
      actionLabel: t('sprayWizard.review.retry'),
      onAction: retry,
    };
  }
  if (outcome === 'done') return { message: t('sprayWizard.review.nothingFound') };
  return { message: t('sprayWizard.review.manualOnly') };
}

/** A determinate bar when the work can count itself, a spinner when it cannot. */
function ProgressBlock({ label, progress }: { label: string; progress: number | null }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.progressBlock}>
      {progress == null ? (
        <ActivityIndicator />
      ) : (
        <View style={[styles.progressTrack, { backgroundColor: systemColors.tertiaryBackground }]}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`,
                backgroundColor: iosSystemColors.systemBlue,
              },
            ]}
          />
        </View>
      )}
      <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    gap: spacing[2],
  },
  // A full-screen iPad cover: the form keeps a readable column, centred.
  tabletContent: {
    maxWidth: SPRAY_FORM_MAX_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  stepCounter: {
    textTransform: 'uppercase',
    marginBottom: spacing[1],
  },
  angleDiagram: {
    alignItems: 'center',
    paddingVertical: spacing[2],
  },
  previewWrap: {
    alignItems: 'center',
    paddingVertical: spacing[3],
    gap: spacing[2],
  },
  photoGuideLink: {
    alignSelf: 'flex-start',
  },
  photoActions: {
    gap: spacing[2],
    paddingTop: spacing[3],
  },
  progressBlock: {
    gap: spacing[3],
    paddingVertical: spacing[6],
    alignItems: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
  doneBlock: {
    gap: spacing[3],
    paddingVertical: spacing[8],
    alignItems: 'center',
  },
});
