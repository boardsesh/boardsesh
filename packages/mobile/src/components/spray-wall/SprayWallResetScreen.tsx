// "The wall got reset" — new photo, corners, compare, confirm (epic #5346, SW-13).
//
// The other half of `SprayWallWizardScreen`, and deliberately not a branch
// inside it. Adding a wall and resetting one share three steps and disagree
// about everything around them: there is no wall to name here, the anchors are
// mandatory rather than optional, and what comes out the far end is not a new
// board but a new GENERATION of one that already carries climbs. The state
// machines are siblings (`reset-wall-machine.ts`) for the same reason.
//
// One route rather than two, even though the compare view is a whole screen of
// its own. The detections are the reason: a wall photograph yields hundreds of
// circles, and expo-router params are strings. Handing them over would mean a
// module-level stash keyed by version id — a second source of truth for the one
// array whose INDICES the proposal is expressed in. The compare view is a
// component (`SprayResetCompareScreen`), so it is still testable on its own and
// still gets the whole screen when it is showing.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { sprayWallDetectionFinished, sprayWallPhotoPicked, sprayWallUploadFinished } from '@boardsesh/analytics';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayCornerMarker } from './SprayCornerMarker';
import { SprayResetCompareScreen } from './SprayResetCompareScreen';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { reportError } from '../../lib/error-reporting';
import { extractGraphqlCode, extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { sprayCapFromErrorCode, sprayCapMessage } from '../../lib/spray/spray-cap-copy';
import { uploadSprayWallPhoto } from '../../lib/spray/spray-wall-photo-upload';
import { suggestSprayHolds } from '../../lib/spray/hold-suggestions';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import { pickWallPhotoFromCamera, pickWallPhotoFromLibrary, rescalePoint } from '../../lib/spray/wall-photo';
import { fetchSprayWallVersions, useCreateSprayWallVersion } from '../../lib/spray/use-create-spray-wall';
import { useDiscardSprayWallVersion, useSprayWallWithVersions } from '../../lib/spray/use-spray-wall-reset';
import {
  anchorsAreReady,
  initialResetWallState,
  isBusy,
  resetBackAction,
  resetWallReducer,
  shouldConfirmLeave,
  type ResetWallStep,
} from './reset-wall-machine';

/** The `beforeRemove` payload this screen re-dispatches once the climber confirms. */
type NavigationRemoveEvent = { preventDefault: () => void; data: { action: unknown } };
type NavigationRemoveSubscribe = (
  event: 'beforeRemove',
  listener: (event: NavigationRemoveEvent) => void,
) => () => void;

/** Widest the photo preview is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PREVIEW_WIDTH = 520;

/** The steps that get a "step N of M" counter — the ones a climber drives. */
const COUNTED_STEPS: readonly ResetWallStep[] = ['photo', 'anchors', 'compare'];

export type SprayWallResetScreenProps = {
  /** The wall being reset. */
  wallUuid: string;
};

export function SprayWallResetScreen({ wallUuid }: SprayWallResetScreenProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const wallQuery = useSprayWallWithVersions(wallUuid);
  const wall = wallQuery.data ?? null;
  const createVersion = useCreateSprayWallVersion();
  const createVersionAsync = createVersion.mutateAsync;
  const discardVersion = useDiscardSprayWallVersion(wallUuid);
  const discardVersionAsync = discardVersion.mutateAsync;

  const [state, dispatch] = useReducer(resetWallReducer, undefined, initialResetWallState);
  const [pickerBusy, setPickerBusy] = useState(false);

  /**
   * Whether the climber has started work this session — a photo picked, or
   * anything after it.
   *
   * Latched against the open-draft screen below, and that is the whole point.
   * `useSprayWallWithVersions` refetches in the background (a remount, a window
   * focus, the query going stale), and an upload that LANDED but lost its
   * response leaves a draft on the wall this session does not know about. The
   * next refetch would then swap a climber who is mid-flow — photo chosen,
   * corners marked — onto "there's a reset half done", throwing both away for a
   * draft the retry is about to adopt anyway (`runUpload` reconciles).
   *
   * So the in-progress state stays authoritative until the climber acts. The
   * open-draft screen is for arriving at a blocked wall, not for being moved to
   * one.
   */
  const hasStartedWork = state.photo != null || state.draft != null;

  // The camera is a property of the BINARY, not of this bundle: SW-02 put the
  // usage description in 2.6.0 and this slice rides an OTA into older ones too.
  const cameraAvailable = useMemo(() => canPhotographWall(), []);

  const previewWidth = Math.min(MAX_PREVIEW_WIDTH, windowWidth - spacing[4] * 2);

  /**
   * The draft this wall already has, if any.
   *
   * A wall carries ONE open draft, so an abandoned reset is in the way of the
   * next one — and it cannot be resumed here: the detections were computed from
   * a local photograph this session does not have, and reviewing a reset with no
   * detections would propose taking every hold off the wall. So the honest offer
   * is to throw the old draft away and start again, which is also the only thing
   * that unblocks the wall.
   */
  const openDraft = useMemo(() => wall?.versions?.find((version) => version.status === 'DRAFT') ?? null, [wall]);

  // ============================================
  // Step 1 — the photo
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
  // Steps 3 and 4 — upload, then suggest
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
      trackSprayEvent(
        sprayWallDetectionFinished({
          outcome: result.outcome,
          candidateCount: result.outcome === 'ok' ? result.candidates.length : 0,
          durationMs: Date.now() - startedAt,
        }),
      );
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
    const anchors = state.anchors;
    // Belt and braces with the reducer's own gate: the flow cannot reach here
    // without four corners, and a reset with none is refused by the server twice
    // over — better to never send the photograph than to be told afterwards.
    if (!photo || !anchors || state.upload.running) return;

    dispatch({ type: 'UPLOAD_STARTED' });
    const startedAt = Date.now();
    const attempt = state.upload.attempts + 1;
    try {
      const uploaded = await uploadSprayWallPhoto({
        wallUuid,
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
      const storedAnchors = anchors.map((point) =>
        rescalePoint(point, { width: photo.width, height: photo.height }, stored),
      );

      // A retry has to reconcile before it creates. `createSprayWallVersion` can
      // land on the server and lose its response on the way back — a dropped
      // connection, a backgrounded app — and the wall then carries a draft this
      // session does not know about. Creating a second one is refused by the
      // one-draft-per-wall rule, so the retry would fail forever on a wall that
      // is actually fine. Adopting the draft that is already there is both the
      // correct state and the only way out.
      const version =
        attempt > 1
          ? ((await fetchSprayWallVersions(wallUuid))?.versions?.find((row) => row.status === 'DRAFT') ??
            (await createVersionAsync({ wallUuid, photoId: uploaded.photoId, anchors: storedAnchors })))
          : await createVersionAsync({ wallUuid, photoId: uploaded.photoId, anchors: storedAnchors });
      dispatch({
        type: 'DRAFT_CREATED',
        draft: {
          versionId: version.id,
          versionNumber: version.number,
          photoWidth: stored.width,
          photoHeight: stored.height,
        },
      });
      await runDetection(photo, stored);
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
      // The version cap is the one a reset can actually hit — fifty resets is four
      // years of monthly changes — and it comes back as an English resolver
      // sentence. Branch on the code and say the number instead.
      const cap = sprayCapFromErrorCode(extractGraphqlCode(error));
      dispatch({
        type: 'UPLOAD_FAILED',
        message: cap ? sprayCapMessage(cap, t) : (extractGraphqlMessage(error) ?? t('sprayWizard.upload.failed')),
      });
    }
  }, [
    state.photo,
    state.anchors,
    state.upload.running,
    state.upload.attempts,
    wallUuid,
    createVersionAsync,
    runDetection,
    t,
  ]);

  // Entering the upload step with nothing in flight and no error to acknowledge
  // starts it.
  useEffect(() => {
    if (state.step !== 'upload') return;
    if (state.upload.running || state.upload.error || state.upload.attempts > 0) return;
    void runUpload();
  }, [state.step, state.upload.running, state.upload.error, state.upload.attempts, runUpload]);

  // ============================================
  // Leaving
  // ============================================

  /**
   * Ask before a removal that would cost something, then let it through.
   *
   * Called from ONE place — the `beforeRemove` listener below — because that is
   * the one place every exit passes through. It is not a helper the footer may
   * also call: doing that is exactly the double prompt this screen had.
   */
  const confirmLeave = useCallback(
    (onConfirm: () => void) => {
      if (!shouldConfirmLeave(state)) {
        onConfirm();
        return;
      }
      Alert.alert(t('sprayReset.leave.title'), t('sprayReset.leave.body'), [
        { text: t('sprayWizard.leave.stay'), style: 'cancel' },
        { text: t('sprayWizard.leave.go'), onPress: onConfirm },
      ]);
    },
    [state, t],
  );

  const goBack = useCallback(() => {
    if (isBusy(state)) return;
    // Pops WITHOUT asking, and that is not a missing guard: popping fires
    // `beforeRemove`, which asks. Asking here as well put two identical alerts on
    // one tap, and the second one's "Stay" undid the answer the climber had just
    // given to the first. One exit, one question — `resetBackAction` has no
    // branch that could prompt, and the listener below owns the only one.
    if (resetBackAction(state) === 'pop-route') {
      router.back();
      return;
    }
    dispatch({ type: 'BACK' });
  }, [state, router]);

  /**
   * The same question for every way out this screen does not draw.
   *
   * The footer's Back was guarded and nothing else was: the header's back
   * button, the iOS back gesture and Android's Back key all remove the route
   * outright — mid-upload, or with a draft on the server whose detections live
   * only in this session. A silent exit there strands a draft nothing can resume
   * and forces the owner to discard it and shoot the wall again.
   *
   * `beforeRemove` is the one place all of them pass through — the footer's Back
   * included, since it pops the route like everything else. So this is the SOLE
   * guard: it replaced a `BackHandler` listener that asked a second time for one
   * Android press, and the footer no longer pre-prompts for the same reason. Two
   * guards on one exit ask twice, and the second alert's "Stay" silently undoes
   * the answer given to the first.
   *
   * The event's own action is re-dispatched on confirm, so the exit the climber
   * chose is the exit they get.
   */
  const navigation = useNavigation();
  const confirmLeaveRef = useRef(confirmLeave);
  confirmLeaveRef.current = confirmLeave;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // Typed loosely on purpose, exactly as `SprayWallWizardScreen` does:
    // `useNavigation()` here is the Expo Router stack's navigation object, and
    // the payload is what has to be re-dispatched to let the removal through.
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

  const handleCommitted = useCallback(
    (summary: { removedCount: number; addedCount: number; climbsChanged: number }) => {
      dispatch({ type: 'COMMITTED' });
      showToast(
        t('sprayReset.done.toast', {
          removed: summary.removedCount,
          added: summary.addedCount,
          climbs: summary.climbsChanged,
        }),
        'success',
      );
      router.back();
    },
    [showToast, t, router],
  );

  const discardOpenDraft = useCallback(async () => {
    if (!openDraft) return;
    hapticSelection();
    try {
      await discardVersionAsync(openDraft.id);
      showToast(t('sprayReset.openDraft.discarded'), 'success');
    } catch (error) {
      reportError(error);
      showToast(extractGraphqlMessage(error) ?? t('sprayReset.openDraft.discardFailed'), 'error');
    }
  }, [openDraft, discardVersionAsync, showToast, t]);

  // ============================================
  // Render
  // ============================================

  if (wallQuery.isPending) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!wall || !wall.viewerCanEdit) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="headline" style={styles.centeredText}>
          {t('sprayReset.notYours')}
        </Text>
        <Button title={t('sprayWizard.back')} variant="text" onPress={() => router.back()} />
      </View>
    );
  }

  // A wall with nothing published has never been set up; a reset is the wrong
  // door for it and `commitSprayWallVersion` would have nothing to supersede.
  if (!wall.currentVersion) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="headline" style={styles.centeredText}>
          {t('sprayReset.nothingPublished')}
        </Text>
        <Button title={t('sprayWizard.back')} variant="text" onPress={() => router.back()} />
      </View>
    );
  }

  // An abandoned draft from an earlier session blocks this one — but only on
  // ARRIVAL. Once the climber has picked a photo, a background refetch must not
  // take the screen off them (see `hasStartedWork`), and once `state.draft`
  // exists the open draft IS this flow's.
  if (openDraft && !hasStartedWork) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="title3" style={styles.centeredText}>
          {t('sprayReset.openDraft.title')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredText}>
          {t('sprayReset.openDraft.body')}
        </Text>
        <Button
          title={t('sprayReset.openDraft.discard')}
          variant="filled"
          size="large"
          onPress={() => void discardOpenDraft()}
          loading={discardVersion.isPending}
          disabled={discardVersion.isPending}
        />
        <Button title={t('sprayWizard.back')} variant="text" onPress={() => router.back()} />
      </View>
    );
  }

  // The compare view is its own full-screen surface with its own header and its
  // own Confirm. It gets the whole screen rather than being boxed into this
  // scroll view, which would put a second scroller around a pinch-zoom board.
  if (state.step === 'compare' && state.draft) {
    return (
      <SprayResetCompareScreen
        wallUuid={wallUuid}
        layoutId={wall.layoutId}
        versionId={state.draft.versionId}
        versionNumber={state.draft.versionNumber}
        candidates={state.detection.candidates}
        onCommitted={handleCommitted}
      />
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
        {/* An admin acted on a report about this wall. A banner, not a gate: the
            owner can still reset it, and a wall that quietly stopped being
            visible to their crew with no explanation would read as data loss.
            `hiddenAt` only ever resolves for the owner, so its presence is the
            whole condition. */}
        {wall.hiddenAt ? (
          <View style={[styles.hiddenNotice, { backgroundColor: systemColors.secondaryBackground }]}>
            <Text variant="headline">{t('sprayHidden.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayHidden.body')}
            </Text>
          </View>
        ) : null}

        {stepIndex >= 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stepCounter}>
            {t('sprayWizard.stepCounter', { current: stepIndex + 1, total: COUNTED_STEPS.length })}
          </Text>
        ) : null}

        {state.step === 'photo' ? (
          <>
            <Text variant="title3">{t('sprayReset.photo.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayReset.photo.body')}
            </Text>
            {state.photo ? (
              <View style={styles.previewWrap}>
                <Image
                  source={{ uri: state.photo.uri }}
                  style={{
                    width: previewWidth,
                    height: previewWidth / (state.photo.width / state.photo.height),
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
            <Text variant="title3">{t('sprayReset.anchors.title')}</Text>
            {/* Not a nicety and not skippable. The wall's canonical frame is
                version 1's photo frame forever, so these four points are the only
                thing that says where THIS photograph sits in it. Without them
                every hold in the new picture arrives labelled with coordinates
                from another one, and the matcher reports the whole wall gone. */}
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayReset.anchors.body')}
            </Text>
            <SprayCornerMarker
              photo={state.photo}
              renderWidth={previewWidth}
              value={state.anchors}
              onChange={(quad) => dispatch({ type: 'ANCHORS_SET', anchors: quad })}
              invalid={state.anchorRejection != null}
            />
            {state.anchorRejection != null ? (
              <Text variant="footnote" color={iosSystemColors.systemRed} accessibilityLiveRegion="polite">
                {t('sprayReset.anchors.notConvex')}
              </Text>
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

        {state.step === 'detect' ? (
          <>
            <Text variant="title3">{t('sprayReset.detect.title')}</Text>
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
      </ScrollView>

      <View
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
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
              title={t('sprayReset.anchors.use')}
              variant="filled"
              size="large"
              onPress={() => dispatch({ type: 'ANCHORS_DONE' })}
              // There is no Skip. Four corners or the flow does not move.
              disabled={!anchorsAreReady(state)}
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
          <Button
            title={t('sprayWizard.upload.retry')}
            variant="filled"
            size="large"
            onPress={() => void runUpload()}
          />
        ) : null}

        <Button title={t('sprayWizard.back')} variant="text" onPress={goBack} disabled={isBusy(state)} />
      </View>
    </KeyboardAvoidingView>
  );
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
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    padding: spacing[4],
  },
  centeredText: {
    textAlign: 'center',
  },
  hiddenNotice: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: borderRadius.lg,
  },
  content: {
    padding: spacing[4],
    gap: spacing[2],
  },
  stepCounter: {
    textTransform: 'uppercase',
    marginBottom: spacing[1],
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing[1],
  },
});
