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
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSprayLeaveGuard } from './use-spray-leave-guard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { sprayWallPhotoPicked, sprayWallUploadFinished } from '@boardsesh/analytics';
import type { SprayDetectionCandidate } from '@boardsesh/shared-schema';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayCornerFooter } from './SprayCornerFooter';
import { SprayCornerStep } from './SprayCornerStep';
import { SprayResetCompareScreen } from './SprayResetCompareScreen';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { hapticSelection } from '../../lib/haptics';
import { reportError } from '../../lib/error-reporting';
import { extractGraphqlCode, extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { sprayCapFromErrorCode, sprayCapMessage } from '../../lib/spray/spray-cap-copy';
import { sprayDraftPurpose } from '../../lib/spray/spray-draft-purpose';
import { sprayHoldEditorHref } from '../../lib/spray/spray-routes';
import { uploadSprayWallPhoto } from '../../lib/spray/spray-wall-photo-upload';
import { SprayDetectionStep } from './SprayDetectionStep';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import { pickWallPhotoFromCamera, pickWallPhotoFromLibrary, rescalePoint } from '../../lib/spray/wall-photo';
import { useCreateSprayWallVersion } from '../../lib/spray/use-create-spray-wall';
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
  const [draftConflict, setDraftConflict] = useState(false);
  // Keep the exact successful upload across create retries; another photo is never adopted.
  const uploadedPhotoRef = useRef<{
    photo: NonNullable<typeof state.photo>;
    uploaded: Awaited<ReturnType<typeof uploadSprayWallPhoto>>;
  } | null>(null);

  /**
   * Whether the climber has started work this session — a photo picked, or
   * anything after it.
   *
   * Latched against the open-draft screen below, and that is the whole point.
   * `useSprayWallWithVersions` refetches in the background (a remount, a window
   * focus, the query going stale), and an upload that LANDED but lost its
   * response leaves a draft on the wall this session does not know about. The
   * next refetch would then swap a climber who is mid-flow — photo chosen,
   * corners marked — onto "there's a reset half done", throwing both away.
   * A conflicting draft discovered during upload requires an explicit choice.
   *
   * So the in-progress state stays authoritative until the climber acts. The
   * open-draft screen is for arriving at a blocked wall, not for being moved to
   * one.
   */
  const hasStartedWork = state.photo != null || state.draft != null;

  // The camera is a property of the BINARY and of the DEVICE, not of this
  // bundle: SW-02 put the usage description in 2.6.0, and an iOS simulator has
  // no camera to open — a picker launched into it aborts the app. Both gates
  // live in `canPhotographWall`.
  const cameraAvailable = useMemo(() => canPhotographWall(Platform.OS), []);

  const previewWidth = Math.min(MAX_PREVIEW_WIDTH, windowWidth - spacing[4] * 2);

  /**
   * The draft this wall already has, if any.
   *
   * A wall carries one open draft. Its stored photo and recognition job survive
   * leaving this screen; resuming never replaces the published wall.
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
  // Steps 3 and 4 — upload, then suggest
  // ============================================

  const runDetection = useCallback(() => dispatch({ type: 'DETECTION_STARTED' }), []);
  const detectionCompleted = useCallback((candidates: SprayDetectionCandidate[]) => {
    dispatch({ type: 'DETECTION_FINISHED', candidates });
  }, []);

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
      const savedUpload = uploadedPhotoRef.current;
      const uploaded =
        savedUpload?.photo === photo
          ? savedUpload.uploaded
          : await uploadSprayWallPhoto({
              wallUuid,
              uri: photo.uri,
              onProgress: (progress) => dispatch({ type: 'UPLOAD_PROGRESS', progress }),
            });
      uploadedPhotoRef.current = { photo, uploaded };
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

      // Backend reconciliation accepts only this exact uploaded object and mapping.
      const version = await createVersionAsync({ wallUuid, photoId: uploaded.photoId, anchors: storedAnchors });
      dispatch({
        type: 'DRAFT_CREATED',
        draft: {
          versionId: version.id,
          versionNumber: version.number,
          photoWidth: stored.width,
          photoHeight: stored.height,
        },
      });
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
      // The version cap is the one a reset can actually hit — fifty resets is four
      // years of monthly changes — and it comes back as an English resolver
      // sentence. Branch on the code and say the number instead.
      if (extractGraphqlCode(error) === 'SPRAY_WALL_DRAFT_ALREADY_OPEN') {
        await wallQuery.refetch();
        setDraftConflict(true);
      }
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
    wallQuery.refetch,
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

  useSprayLeaveGuard(shouldConfirmLeave(state), {
    title: t('sprayReset.leave.title'),
    body: t('sprayReset.leave.body'),
    stay: t('sprayWizard.leave.stay'),
    leave: t('sprayWizard.leave.go'),
  });

  const goBack = useCallback(() => {
    if (isBusy(state)) return;
    // Route exits pass through the native removal guard exactly once.
    if (resetBackAction(state) === 'pop-route') {
      router.back();
      return;
    }
    dispatch({ type: 'BACK' });
  }, [state, router]);

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
      setDraftConflict(false);
      // Keep the chosen new photo and its upload: we discarded the conflicting
      // saved draft, which references a different object.
      dispatch({ type: 'DRAFT_DISCARDED' });
      showToast(t('sprayReset.openDraft.discarded'), 'success');
    } catch (error) {
      reportError(error);
      showToast(extractGraphqlMessage(error) ?? t('sprayReset.openDraft.discardFailed'), 'error');
    }
  }, [openDraft, discardVersionAsync, showToast, t]);

  // ============================================
  // Render
  // ============================================

  if (wallQuery.isPending || (!hasStartedWork && wallQuery.isFetching)) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
        <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
          {t('sprayReset.loading')}
        </Text>
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
  if (openDraft && (!hasStartedWork || draftConflict)) {
    if (sprayDraftPurpose(openDraft, wall.currentVersion) !== 'reset') {
      return (
        <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
          <Text variant="title3" style={styles.centeredText}>
            {t('sprayReset.openDraft.holdEditTitle')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredText}>
            {t('sprayReset.openDraft.holdEditBody')}
          </Text>
          <Button
            title={t('sprayMaintenance.screenTitle')}
            onPress={() => router.replace(sprayHoldEditorHref(wallUuid))}
          />
          <Button title={t('sprayWizard.back')} variant="text" onPress={() => router.back()} />
        </View>
      );
    }
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="title3" style={styles.centeredText}>
          {t('sprayReset.openDraft.title')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredText}>
          {t('sprayReset.openDraft.body')}
        </Text>
        {openDraft.photo?.width && openDraft.photo?.height ? (
          <Button
            title={t('sprayDetection.resume')}
            onPress={() => {
              const { width, height } = openDraft.photo ?? {};
              if (!width || !height) return;
              setDraftConflict(false);
              dispatch({
                type: 'DRAFT_CREATED',
                draft: {
                  versionId: openDraft.id,
                  versionNumber: openDraft.number,
                  photoWidth: width,
                  photoHeight: height,
                },
              });
              runDetection();
            }}
          />
        ) : null}
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

  // Its own screenful rather than a section of the scrolling page below: the
  // photo is fitted to the space between the header and the footer, so all four
  // rings are on screen and a vertical drag is never also a scroll (#5958).
  if (state.step === 'anchors' && state.photo) {
    return (
      <View style={styles.flex}>
        {/* Not a nicety and not skippable. The wall's canonical frame is
            version 1's photo frame forever, so these four points are the only
            thing that says where THIS photograph sits in it. Without them
            every hold in the new picture arrives labelled with coordinates
            from another one, and the matcher reports the whole wall gone. */}
        <SprayCornerStep
          stepCounter={t('sprayWizard.stepCounter', { current: stepIndex + 1, total: COUNTED_STEPS.length })}
          title={t('sprayReset.anchors.title')}
          body={t('sprayReset.anchors.body')}
          photo={state.photo}
          value={state.anchors}
          onChange={(quad) => dispatch({ type: 'ANCHORS_SET', anchors: quad })}
          invalid={state.anchorRejection != null}
        />
        <SprayCornerFooter
          primaryTitle={t('sprayReset.anchors.use')}
          onPrimary={() => dispatch({ type: 'ANCHORS_DONE' })}
          // There is no Skip. Four corners or the flow does not move.
          primaryDisabled={!anchorsAreReady(state)}
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
          <SprayDetectionStep wallUuid={wallUuid} versionId={state.draft.versionId} onComplete={detectionCompleted} />
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
