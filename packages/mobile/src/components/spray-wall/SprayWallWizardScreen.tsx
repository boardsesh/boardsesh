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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS, sprayHoldsReviewed, sprayWallPhotoPicked, sprayWallUploadFinished } from '@boardsesh/analytics';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import type { UserBoard, SprayDetectionCandidate } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { GymPickerSheet } from '../board-discovery/GymPickerSheet';
import { SprayCornerFooter } from './SprayCornerFooter';
import { SprayCornerStep } from './SprayCornerStep';
import {
  confirmDiscardSprayEdits,
  SprayHoldEditorScreen,
  type SprayEditorNotice,
  type SprayHoldSaveSummary,
} from '../outline-editor/SprayHoldEditorScreen';
import { BoardIdentityFields, BoardVisibilityFields, SectionLabel } from '../board-discovery/BoardMetaFields';
import { SPRAY_ANGLE_OPTIONS, useSprayWallBuilder } from '../board-discovery/use-spray-wall-builder';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { AngleBoardDiagram } from '../play-drawer/AngleBoardDiagram';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { reportError } from '../../lib/error-reporting';
import { openExternalUrl } from '../../lib/open-url';
import { buildHelpUrl } from '../../lib/help-url';
import { extractGraphqlCode, extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { SPRAY_CAP_VALUES, sprayCapFromErrorCode, sprayCapMessage } from '../../lib/spray/spray-cap-copy';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import { activatePublishedSprayWall } from '../../lib/spray/activate-published-spray-wall';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { invalidateSprayWallRenderData } from '../../lib/spray/spray-wall-loader';
import { prefetchSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import {
  fetchSprayWallVersions,
  useCreateSprayWall,
  useCreateSprayWallVersion,
  useDiscardSprayWallDraft,
  useMySprayWalls,
  usePublishSprayWallVersion,
  useUpdateSprayWallVisibility,
} from '../../lib/spray/use-create-spray-wall';
import { uploadSprayWallPhoto } from '../../lib/spray/spray-wall-photo-upload';
import { wallCreatedEventProperties } from './wall-created-event';
import { SprayDetectionStep } from './SprayDetectionStep';
import { SprayWallLookStep } from './SprayWallLookStep';
import { useSprayWizardLeaveGuard } from './use-spray-wizard-leave-guard';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import { pickWallPhotoFromCamera, pickWallPhotoFromLibrary, rescalePoint } from '../../lib/spray/wall-photo';
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

/** The angle list as `AngleSlider` takes it. Built once: it never changes. */
const sprayAngles: number[] = [...SPRAY_ANGLE_OPTIONS];

/** Widest the photo preview is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PREVIEW_WIDTH = 520;

/** The steps that get a "step N of M" counter — the ones a climber drives. */
const COUNTED_STEPS: readonly AddWallStep[] = ['meta', 'photo', 'anchors', 'review', 'look', 'publish'];

type SprayWallWizardScreenProps = {
  /** Which tab the flow dismisses back to once the wall is bound. */
  returnTo: BoardReturnTo;
};

export function SprayWallWizardScreen({ returnTo }: SprayWallWizardScreenProps) {
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
  const capOrServerMessage = useCallback(
    (error: unknown, fallback: string): string => {
      const cap = sprayCapFromErrorCode(extractGraphqlCode(error));
      if (cap) return sprayCapMessage(cap, t);
      return extractGraphqlMessage(error) ?? fallback;
    },
    [t],
  );
  const router = useRouter();
  const queryClient = useQueryClient();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const builder = useSprayWallBuilder();
  const [state, dispatch] = useReducer(addWallReducer, undefined, initialAddWallState);
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
    isLocalOnly: true,
    writeFailure: 'rethrow',
    haptic: false,
  });

  const previewWidth = Math.min(MAX_PREVIEW_WIDTH, windowWidth - spacing[4] * 2);

  // ============================================
  // Step 0 — is there a wall to pick up?
  // ============================================

  // Only while the flow is actually asking. Once it has an answer the query is
  // dead weight, and refetching it mid-flow could offer to resume the very wall
  // this run just created.
  const mySprayWalls = useMySprayWalls({ enabled: state.step === 'resuming' });
  // `refetch` comes out with the rest of the fields on purpose. React Query keeps
  // it stable for the query's life, where the RESULT object is a fresh reference
  // on every render — so a callback closing over the whole thing would be rebuilt
  // on every commit, including each one an upload progress tick causes.
  const { isFetching: wallsFetching, dataUpdatedAt, errorUpdatedAt, refetch: refetchMySprayWalls } = mySprayWalls;
  const walls = mySprayWalls.data;
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

  const decideResume = useCallback(
    async (resumable: NonNullable<ReturnType<typeof findResumableWall>>, choice: 'resume' | 'startOver') => {
      // The list carries no version history, so the draft — and whether it has a
      // photo — takes one more round trip. A FAILURE here is not "no draft":
      // treating it as one sends the climber to the photo step, where
      // `createSprayWallVersion` then refuses every upload forever because the
      // draft it could not see is still open. So it surfaces and offers a retry.
      const full = await fetchSprayWallVersions(resumable.uuid).catch(() => null);
      if (!full) {
        setResumeError(t('sprayWizard.resume.checkFailed'));
        resumeAskedRef.current = false;
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
    [discardDraftAsync, t],
  );

  useEffect(() => {
    if (state.step !== 'resuming' || !wallsSettled || resumeAskedRef.current) return;
    resumeAskedRef.current = true;

    // A failed list is not a reason to block: the worst case is one extra wall
    // against the cap, and refusing to let somebody add a wall because we could
    // not check for an old one is far worse.
    const resumable = walls ? findResumableWall(walls) : null;
    if (!resumable) {
      dispatch({ type: 'RESUME_DECLINED' });
      return;
    }

    Alert.alert(t('sprayWizard.resume.title'), t('sprayWizard.resume.body', { name: resumable.board.name }), [
      {
        text: t('sprayWizard.resume.startOver'),
        style: 'destructive',
        onPress: () => void decideResume(resumable, 'startOver'),
      },
      { text: t('sprayWizard.resume.pickUp'), onPress: () => void decideResume(resumable, 'resume') },
    ]);
  }, [state.step, wallsSettled, walls, decideResume, t]);

  /** Ask again after a version-history request failed. */
  const retryResume = useCallback(() => {
    setResumeError(null);
    resumeAskedRef.current = false;
    mountedAtRef.current = Date.now();
    void refetchMySprayWalls();
  }, [refetchMySprayWalls]);

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
        }),
      );
      dispatch({ type: 'UPLOAD_FAILED', message: capOrServerMessage(error, t('sprayWizard.upload.failed')) });
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
        dispatch({ type: 'PUBLISHED' });
        // Register the PUBLISHED generation right now. SW-07's revalidation
        // window would get there eventually, but the device that published
        // already knows the version moved — and until it re-registers, every
        // spray cache key still names the draft the climber was editing.
        await invalidateSprayWallRenderData(queryClient, draft.wallUuid, draft.layoutId);
        // Built from the wall itself, not from `builder`: a resumed run never ran
        // the meta step, so the builder's fields are its constructor defaults and
        // reporting them would bias this funnel for every wall finished on a
        // second sitting. `wall-created-event.ts` carries the whole rule.
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
          }),
        );
      }

      // Idempotent, and after the latch above, so a retry of a failed bind
      // re-applies it rather than re-publishing.
      if (visibility) {
        await updateVisibilityAsync({ uuid: draft.wallUuid, ...visibility });
      }

      // Fetch the published visibility before persisting the active board.
      // A failed read leaves the published latch set, so retry only binds.
      await activatePublishedSprayWall(queryClient, draft.wallUuid, finish);
    } catch (error) {
      reportError(error);
      dispatch({ type: 'PUBLISH_FAILED', message: capOrServerMessage(error, t('sprayWizard.publish.failed')) });
    }
  }, [state, publishVersionAsync, updateVisibilityAsync, queryClient, builder, finish, t]);

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
    // the server by then — so back means leaving, which keeps the draft.
    if (backLeavesFlow(state)) {
      router.back();
      return;
    }
    dispatch({ type: 'BACK' });
  }, [state, router]);

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
          current: COUNTED_STEPS.indexOf('look') + 1,
          total: COUNTED_STEPS.length,
        })}
        onSaveStarted={onLookSaveStarted}
        onSaveFailed={onLookSaveFailed}
        onConfirmed={onLookConfirmed}
      />
    );
  }

  const stepIndex = COUNTED_STEPS.indexOf(state.step);

  // Its own screenful rather than a section of the scrolling page below: the
  // photo is fitted to the space between the header and the footer, so all four
  // rings are on screen and a vertical drag is never also a scroll (#5958).
  if (state.step === 'anchors' && state.photo) {
    return (
      <View style={styles.flex}>
        <SprayCornerStep
          stepCounter={t('sprayWizard.stepCounter', { current: stepIndex + 1, total: COUNTED_STEPS.length })}
          title={t('sprayWizard.anchors.title')}
          body={t('sprayWizard.anchors.body')}
          photo={state.photo}
          value={state.anchors}
          onChange={(quad) => dispatch({ type: 'ANCHORS_SET', anchors: quad })}
          invalid={state.anchorRejection != null}
        />
        <SprayCornerFooter
          primaryTitle={state.anchors ? t('sprayWizard.anchors.use') : t('sprayWizard.anchors.skip')}
          onPrimary={() => dispatch({ type: 'ANCHORS_DONE' })}
          // Unlike the reset flow, no corners is a valid answer here (that is
          // Skip), so only a refused quad shuts the gate.
          primaryDisabled={state.anchorRejection != null}
          canClear={state.anchors != null}
          onClear={() => dispatch({ type: 'ANCHORS_CLEARED' })}
          onBack={goBack}
          backDisabled={isBusy(state)}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {stepIndex >= 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stepCounter}>
            {t('sprayWizard.stepCounter', { current: stepIndex + 1, total: COUNTED_STEPS.length })}
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
              {resumeError ?? t('sprayWizard.resume.checking')}
            </Text>
            {resumeError ? (
              <Button title={t('sprayWizard.resume.retry')} variant="filled" onPress={retryResume} />
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

            <BoardVisibilityFields builder={builder} publicHint={t('sprayWizard.meta.publicHint')} />

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
            <Text variant="title3">{t('sprayWizard.photo.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.photo.body')}
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

      <View
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
        {/* Nothing here while the resume check runs: the body already shows the
            spinner and its label, and a second copy in the footer read as two
            things happening rather than one. */}

        {state.step === 'meta' ? (
          <Button
            title={t('sprayWizard.meta.next')}
            variant="filled"
            size="large"
            onPress={() => dispatch({ type: 'META_DONE' })}
            disabled={!builder.canCreate}
          />
        ) : null}

        {state.step === 'photo' ? (
          <Button
            title={t('sprayWizard.photo.next')}
            variant="filled"
            size="large"
            onPress={() => dispatch({ type: 'PHOTO_CONFIRMED' })}
            disabled={state.photo == null}
          />
        ) : null}

        {state.step === 'upload' && state.upload.error ? (
          <Button title={t('sprayWizard.upload.retry')} variant="filled" size="large" onPress={retryUpload} />
        ) : null}

        {state.step === 'publish' && state.publish.error ? (
          <Button
            title={t('sprayWizard.publish.retry')}
            variant="filled"
            size="large"
            onPress={() => void publish()}
            loading={state.publish.running}
            disabled={state.publish.running}
          />
        ) : null}

        {state.step !== 'done' && state.step !== 'resuming' ? (
          <Button title={t('sprayWizard.back')} variant="text" onPress={goBack} disabled={isBusy(state)} />
        ) : null}
      </View>
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing[1],
  },
});
