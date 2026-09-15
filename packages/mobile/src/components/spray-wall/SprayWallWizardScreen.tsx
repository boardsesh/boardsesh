// "Add a spray wall", end to end (epic #5346, SW-09).
//
// Name it → photograph it → optionally mark its corners → upload → let the phone
// suggest holds → correct them → publish. One route, not seven: the steps share
// state that must survive going back (`add-wall-machine.ts` is the transition
// table), and two of them — the anchors and the hold editor — are full-screen
// pan-and-pinch surfaces, which `docs/mobile-sheets-vs-routes.md` rule 3 puts on
// a route rather than in a sheet.
//
// Everything that can fail, fails into somewhere the climber can act:
//
//  - the photo library says no        → the step stays put and says so
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
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { GymPickerSheet } from '../board-discovery/GymPickerSheet';
import { SprayCornerMarker } from './SprayCornerMarker';
import { SprayHoldEditorScreen } from '../outline-editor/SprayHoldEditorScreen';
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
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { invalidateSprayWallRenderData } from '../../lib/spray/spray-wall-loader';
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
import { suggestSprayHolds } from '../../lib/spray/hold-suggestions';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import { pickWallPhotoFromCamera, pickWallPhotoFromLibrary, rescalePoint } from '../../lib/spray/wall-photo';
import {
  addWallReducer,
  initialAddWallState,
  isBusy,
  shouldConfirmLeave,
  type AddWallStep,
  type CreatedWall,
  type CreatedWallDraft,
} from './add-wall-machine';
import { findResumableWall, planUploadRetry, resumeTargetFor, startOverPlan } from './resume-draft';

/** The `beforeRemove` payload this screen re-dispatches once the climber confirms. */
type NavigationRemoveEvent = { preventDefault: () => void; data: { action: unknown } };
type NavigationRemoveSubscribe = (
  event: 'beforeRemove',
  listener: (event: NavigationRemoveEvent) => void,
) => () => void;

/** The angle list as `AngleSlider` takes it. Built once: it never changes. */
const sprayAngles: number[] = [...SPRAY_ANGLE_OPTIONS];

/** Widest the photo preview is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PREVIEW_WIDTH = 520;

/** The steps that get a "step N of M" counter — the ones a climber drives. */
const COUNTED_STEPS: readonly AddWallStep[] = ['meta', 'photo', 'anchors', 'review', 'publish'];

type SprayWallWizardScreenProps = {
  /** Which tab the flow dismisses back to once the wall is bound. */
  returnTo: BoardReturnTo;
};

export function SprayWallWizardScreen({ returnTo }: SprayWallWizardScreenProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
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

  // The camera is a property of the BINARY, not of this bundle: SW-02 put the
  // usage description in 2.6.0 and this slice rides an OTA into older ones too.
  const cameraAvailable = useMemo(() => canPhotographWall(), []);

  const discardDraft = useDiscardSprayWallDraft();
  const discardDraftAsync = discardDraft.mutateAsync;

  /**
   * The wall's `user_boards` row, as `useActivateBoard` needs it.
   *
   * A ref and not machine state because it is a PAYLOAD rather than an identity:
   * the machine holds which wall this is (and must, so a retry cannot mint a
   * second one), while this is the board object to hand to the bind. It is
   * filled either by `createSprayWall` or, on a resumed wall, by the list the
   * resume check already fetched.
   */
  const boardRef = useRef<UserBoard | null>(null);

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
  const { isFetching: wallsFetching, dataUpdatedAt, errorUpdatedAt } = mySprayWalls;
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
          await discardDraftAsync({ versionId: plan.discardVersionId, wallUuid: plan.deleteWallUuid });
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
    void mySprayWalls.refetch();
  }, [mySprayWalls]);

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
        if (result.outcome === 'denied') {
          showToast(
            source === 'camera' ? t('sprayWizard.photo.cameraDenied') : t('sprayWizard.photo.libraryDenied'),
            'warning',
          );
          return;
        }
        if (result.outcome === 'cancelled') return;
        track(SHARED_EVENTS.SprayWallPhotoPicked, { source });
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

  const runDetection = useCallback(
    async (photo: { uri: string; width: number; height: number }, stored: { width: number; height: number }) => {
      dispatch({ type: 'DETECTION_STARTED' });
      const startedAt = Date.now();
      const result = await suggestSprayHolds({
        photo,
        storedPhoto: stored,
        onProgress: (done, total) => dispatch({ type: 'DETECTION_PROGRESS', done, total }),
      });
      track(SHARED_EVENTS.SprayWallDetectionFinished, {
        outcome: result.outcome,
        candidateCount: result.outcome === 'ok' ? result.candidates.length : 0,
        durationMs: Date.now() - startedAt,
      });
      if (result.outcome === 'ok') {
        dispatch({ type: 'DETECTION_FINISHED', candidates: result.candidates });
        return;
      }
      dispatch({ type: result.outcome === 'unavailable' ? 'DETECTION_UNAVAILABLE' : 'DETECTION_FAILED' });
    },
    [],
  );

  const runUpload = useCallback(async () => {
    const photo = state.photo;
    if (!photo || state.upload.running) return;
    // A wall that already has a draft has already had a photo adopted onto it,
    // and `createSprayWallVersion` refuses a second while one is open. Re-running
    // the upload from here would spend the photo and then fail on a rule the
    // climber cannot see; the way on from a draft is detection, not upload.
    if (state.draft) return;
    // Only needed when there is no wall yet. A resumed wall already carries its
    // name, angle and visibility on the row, so the meta step never ran.
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
          return;
        }
      }
      if (!wall) {
        // `input` is non-null here — the guard above returns when both are.
        const created = await createWallAsync(input!);
        wall = { wallUuid: created.uuid, layoutId: created.layoutId, viewerCanEdit: created.viewerCanEdit };
        boardRef.current = created.board;
        // Recorded BEFORE the upload, so a failure here still leaves the flow
        // pointing at the wall that exists rather than minting another on retry.
        dispatch({ type: 'WALL_CREATED', wall });
      }

      const uploaded = await uploadSprayWallPhoto({
        wallUuid: wall.wallUuid,
        uri: photo.uri,
        onProgress: (progress) => dispatch({ type: 'UPLOAD_PROGRESS', progress }),
      });
      track(SHARED_EVENTS.SprayWallUploadFinished, {
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
        determinate: uploaded.determinate,
        attempt,
      });

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
      await runDetection(photo, stored);
    } catch (error) {
      reportError(error);
      track(SHARED_EVENTS.SprayWallUploadFinished, {
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        determinate: false,
        attempt,
      });
      dispatch({ type: 'UPLOAD_FAILED', message: extractGraphqlMessage(error) ?? t('sprayWizard.upload.failed') });
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

  // ============================================
  // Step 7 — publish, bind, leave
  // ============================================

  const publish = useCallback(async () => {
    const { draft, wall, published } = state;
    const board = boardRef.current;
    if (!draft || !wall || state.publish.running) return;
    dispatch({ type: 'PUBLISH_STARTED' });
    hapticSelection();
    try {
      // Skipped once the version is already published. Publishing and binding
      // the wall as the active board are two writes behind one button, and
      // `publishSprayWallVersion` refuses a version that has already landed — so
      // a retry that re-ran both would turn a failed bind into a dead end.
      if (!published) {
        await publishVersionAsync(draft.versionId);
        dispatch({ type: 'PUBLISHED' });
        // Register the PUBLISHED generation right now. SW-07's revalidation
        // window would get there eventually, but the device that published
        // already knows the version moved — and until it re-registers, every
        // spray cache key still names the draft the climber was editing.
        await invalidateSprayWallRenderData(queryClient, draft.wallUuid, draft.layoutId);
        track(SHARED_EVENTS.BoardCreated, {
          boardType: 'spray',
          layoutId: wall.layoutId,
          // A wall's size id EQUALS its layout id by construction — it has
          // exactly one size, itself (`spraySizeIdForLayout`).
          sizeId: wall.layoutId,
          setCount: 1,
          angle: builder.angle ?? 0,
          isOwned: true,
          isPublic: builder.isPublic,
          hasLocationName: builder.locationName.trim().length > 0,
          hasCoords: builder.coords != null,
          hasGym: builder.selectedGym != null,
          gymUuid: builder.selectedGym?.uuid ?? undefined,
          source: 'spray_wizard',
        });
      }

      // The visibility the climber chose, applied now rather than at creation:
      // a wall is created private so an unfinished one is never discoverable as
      // an unusable board. Idempotent, and after the latch above, so a retry of
      // a failed bind re-applies it rather than re-publishing.
      const visibility = builder.pendingVisibility();
      if (visibility) {
        await updateVisibilityAsync({ uuid: draft.wallUuid, ...visibility });
      }

      // Binds the wall as the active board and dismisses back to the tab the
      // flow was opened from, where the Climbs empty state takes over. A wall
      // whose board payload never arrived is still published — it just is not
      // switched to, which the board picker fixes in one tap.
      if (board) await finish(board);
      else router.back();
    } catch (error) {
      reportError(error);
      dispatch({ type: 'PUBLISH_FAILED', message: extractGraphqlMessage(error) ?? t('sprayWizard.publish.failed') });
    }
  }, [state, publishVersionAsync, updateVisibilityAsync, queryClient, builder, finish, router, t]);

  /** Ask, then run `onConfirm` — or run it straight away when there is nothing to ask about. */
  const confirmLeave = useCallback(
    (onConfirm: () => void) => {
      if (!shouldConfirmLeave(state)) {
        onConfirm();
        return;
      }
      Alert.alert(t('sprayWizard.leave.title'), t('sprayWizard.leave.body'), [
        { text: t('sprayWizard.leave.stay'), style: 'cancel' },
        { text: t('sprayWizard.leave.go'), onPress: onConfirm },
      ]);
    },
    [state, t],
  );

  const leave = useCallback(() => confirmLeave(() => router.back()), [confirmLeave, router]);

  /**
   * The same question for the ways out this screen does not draw.
   *
   * The footer's Back was guarded; the header's back button, the iOS back
   * gesture and Android's Back key were not, and all three remove the route
   * outright — mid-upload, mid-publish, or with holds the editor has not written
   * yet. `beforeRemove` is the one place all of them pass through.
   */
  const navigation = useNavigation();
  const confirmLeaveRef = useRef(confirmLeave);
  confirmLeaveRef.current = confirmLeave;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // Typed loosely on purpose: `useNavigation()` here is the Expo Router stack's
    // navigation object, and the event's payload is what has to be re-dispatched
    // to let the removal through.
    const subscribe = (navigation as unknown as { addListener?: NavigationRemoveSubscribe }).addListener;
    if (typeof subscribe !== 'function') return;
    return subscribe.call(navigation, 'beforeRemove', (event: NavigationRemoveEvent) => {
      if (!shouldConfirmLeave(stateRef.current)) return;
      event.preventDefault();
      confirmLeaveRef.current(() => {
        (navigation as unknown as { dispatch: (action: unknown) => void }).dispatch(event.data.action);
      });
    });
  }, [navigation]);

  const goBack = useCallback(() => {
    if (isBusy(state)) return;
    // `review` and `publish` have no step behind them — the draft is on the
    // server by then — so back means leaving, which keeps the draft.
    if (state.step === 'meta' || state.step === 'review' || state.step === 'publish') {
      leave();
      return;
    }
    dispatch({ type: 'BACK' });
  }, [state, leave]);

  const candidateCount = state.detection.candidates.length;
  const onHoldsSaved = useCallback(
    ({ written }: { written: number; removed: number }) => {
      track(SHARED_EVENTS.SprayHoldsReviewed, { holdCount: written, hadCandidates: candidateCount > 0 });
      dispatch({ type: 'HOLDS_SAVED', holdCount: written });
    },
    [candidateCount],
  );

  // ============================================
  // Render
  // ============================================

  // The editor is its own full-screen surface with its own toolbar and its own
  // save. It gets the whole screen rather than being boxed into the wizard's
  // scroll view, which would put a second scroller around a pinch-zoom board.
  if (state.step === 'review' && state.draft) {
    return (
      <View style={styles.flex}>
        <View style={[styles.reviewBar, { borderBottomColor: systemColors.separator }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.reviewHint}>
            {detectionSummary(state, t)}
          </Text>
          <Button
            title={t('sprayWizard.review.done')}
            variant="filled"
            onPress={() => dispatch({ type: 'REVIEW_DONE' })}
            disabled={!state.hasSavedHolds}
          />
        </View>
        <SprayHoldEditorScreen
          wallUuid={state.draft.wallUuid}
          layoutId={state.draft.layoutId}
          versionId={state.draft.versionId}
          versionNumber={state.draft.versionNumber}
          viewerCanEdit={state.draft.viewerCanEdit}
          candidates={state.detection.candidates}
          onSaved={onHoldsSaved}
        />
      </View>
    );
  }

  const stepIndex = COUNTED_STEPS.indexOf(state.step);

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
          </>
        ) : null}

        {state.step === 'photo' ? (
          <>
            <Text variant="title3">{t('sprayWizard.photo.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.photo.body')}
            </Text>
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
          </>
        ) : null}

        {state.step === 'anchors' && state.photo ? (
          <>
            <Text variant="title3">{t('sprayWizard.anchors.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.anchors.body')}
            </Text>
            <SprayCornerMarker
              photo={state.photo}
              renderWidth={previewWidth}
              value={state.anchors}
              onChange={(quad) => dispatch({ type: 'ANCHORS_SET', anchors: quad })}
              invalid={state.anchorRejection != null}
            />
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

        {state.step === 'detect' ? (
          <>
            <Text variant="title3">{t('sprayWizard.detect.title')}</Text>
            <ProgressBlock
              label={
                state.detection.total > 0
                  ? t('sprayWizard.detect.tiles', { done: state.detection.done, total: state.detection.total })
                  : t('sprayWizard.detect.working')
              }
              progress={state.detection.total > 0 ? state.detection.done / state.detection.total : null}
            />
          </>
        ) : null}

        {state.step === 'publish' ? (
          <>
            <Text variant="title3">{t('sprayWizard.publish.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.publish.body')}
            </Text>
            {state.publish.error ? (
              <Text variant="subheadline" color={iosSystemColors.systemRed} accessibilityLiveRegion="polite">
                {state.publish.error}
              </Text>
            ) : null}
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

        {state.step === 'anchors' ? (
          <View style={styles.anchorActions}>
            <Button
              title={state.anchors ? t('sprayWizard.anchors.use') : t('sprayWizard.anchors.skip')}
              variant="filled"
              size="large"
              onPress={() => dispatch({ type: 'ANCHORS_DONE' })}
              disabled={state.anchorRejection != null}
            />
            {state.anchors ? (
              <Button
                title={t('sprayWizard.anchors.clear')}
                variant="text"
                onPress={() => dispatch({ type: 'ANCHORS_CLEARED' })}
              />
            ) : null}
          </View>
        ) : null}

        {state.step === 'upload' && state.upload.error ? (
          <Button title={t('sprayWizard.upload.retry')} variant="filled" size="large" onPress={retryUpload} />
        ) : null}

        {state.step === 'publish' ? (
          <Button
            title={t('sprayWizard.publish.cta')}
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

/** What the review bar says about where its candidates came from. */
function detectionSummary(
  state: { detection: { outcome: string; candidates: readonly unknown[] } },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (state.detection.outcome === 'unavailable') return t('sprayWizard.review.manualOnly');
  if (state.detection.outcome === 'failed') return t('sprayWizard.review.detectionFailed');
  if (state.detection.candidates.length === 0) return t('sprayWizard.review.nothingFound');
  // `{{value}}` and not `{{count}}`: the four catalogs interpolate `value`, and
  // i18next leaves an unmatched placeholder in the string verbatim — so the wrong
  // name here does not fall back, it ships "{{value}} holds to check" to a
  // climber. It is also i18next's plural key, which these strings do not use.
  return t('sprayWizard.review.found', { value: state.detection.candidates.length });
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
  photoActions: {
    gap: spacing[2],
    paddingTop: spacing[3],
  },
  anchorActions: {
    gap: spacing[1],
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
  reviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  reviewHint: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing[1],
  },
});
