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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayCornerMarker } from './SprayCornerMarker';
import { SprayHoldEditorScreen } from '../outline-editor/SprayHoldEditorScreen';
import {
  BoardIdentityFields,
  BoardVisibilityFields,
  BuilderTextInput,
  SectionLabel,
} from '../board-discovery/BoardMetaFields';
import { MAX_SPRAY_ANGLE, MIN_SPRAY_ANGLE, useSprayWallBuilder } from '../board-discovery/use-spray-wall-builder';
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
  useCreateSprayWall,
  useCreateSprayWallVersion,
  usePublishSprayWallVersion,
} from '../../lib/spray/use-create-spray-wall';
import { uploadSprayWallPhoto } from '../../lib/spray/spray-wall-photo-upload';
import { suggestSprayHolds } from '../../lib/spray/hold-suggestions';
import { canPhotographWall } from '../../lib/spray/camera-capability';
import { pickWallPhotoFromCamera, pickWallPhotoFromLibrary, rescalePoint } from '../../lib/spray/wall-photo';
import {
  addWallReducer,
  initialAddWallState,
  isBusy,
  leavingKeepsDraft,
  type AddWallStep,
  type CreatedWallDraft,
} from './add-wall-machine';

/** Widest the photo preview is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PREVIEW_WIDTH = 520;

/** The steps that get a "step N of M" counter — the ones a climber drives. */
const COUNTED_STEPS: readonly AddWallStep[] = ['meta', 'photo', 'anchors', 'review', 'publish'];

type SprayWallWizardScreenProps = {
  /** Which tab the flow dismisses back to once the wall is bound. */
  returnTo: BoardReturnTo;
};

/** The wall as it exists between `createSprayWall` and the first publish. */
type CreatedWall = { uuid: string; layoutId: number; viewerCanEdit: boolean; board: UserBoard };

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

  const createWall = useCreateSprayWall();
  const createVersion = useCreateSprayWallVersion();
  const publishVersion = usePublishSprayWallVersion();
  // `mutateAsync` is bound once by the MutationObserver; the mutation OBJECTS are
  // fresh literals on every render, so closing over the objects would rebuild
  // every callback below on each commit.
  const createWallAsync = createWall.mutateAsync;
  const createVersionAsync = createVersion.mutateAsync;
  const publishVersionAsync = publishVersion.mutateAsync;

  // The camera is a property of the BINARY, not of this bundle: SW-02 put the
  // usage description in 2.6.0 and this slice rides an OTA into older ones too.
  const cameraAvailable = useMemo(() => canPhotographWall(), []);

  /**
   * The wall, once created, held outside render state.
   *
   * A retry must not create a second wall, and `state.draft` is only written
   * once the DRAFT VERSION lands — so between "the wall exists" and "the version
   * exists" there is a window where the only record of the wall is this ref.
   * Losing it would make every retry of a failed upload mint another wall, and
   * the per-account cap is ten.
   */
  const createdWallRef = useRef<CreatedWall | null>(null);

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
    const input = builder.buildCreateInput();
    if (!input) return;

    dispatch({ type: 'UPLOAD_STARTED' });
    const startedAt = Date.now();
    const attempt = state.upload.attempts + 1;
    try {
      // The wall first: the upload handler authorises the photo against a wall
      // the caller owns, so there is no order in which the photo could go first.
      let wall = createdWallRef.current;
      if (!wall) {
        const created = await createWallAsync(input);
        wall = {
          uuid: created.uuid,
          layoutId: created.layoutId,
          viewerCanEdit: created.viewerCanEdit,
          board: created.board,
        };
        createdWallRef.current = wall;
      }

      const uploaded = await uploadSprayWallPhoto({
        wallUuid: wall.uuid,
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

      const version = await createVersionAsync({ wallUuid: wall.uuid, photoId: uploaded.photoId, anchors });
      const draft: CreatedWallDraft = {
        wallUuid: wall.uuid,
        layoutId: wall.layoutId,
        versionId: version.id,
        versionNumber: version.number,
        viewerCanEdit: wall.viewerCanEdit,
      };
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
    state.upload.running,
    state.upload.attempts,
    builder,
    createWallAsync,
    createVersionAsync,
    runDetection,
    t,
  ]);

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
    const draft = state.draft;
    const wall = createdWallRef.current;
    if (!draft || !wall || state.publish.running) return;
    dispatch({ type: 'PUBLISH_STARTED' });
    hapticSelection();
    try {
      await publishVersionAsync(draft.versionId);
      // Register the PUBLISHED generation right now. SW-07's revalidation window
      // would get there eventually, but the device that published already knows
      // the version moved — and until it re-registers, every spray cache key
      // still names the draft the climber was editing.
      await invalidateSprayWallRenderData(queryClient, draft.wallUuid, draft.layoutId);
      track(SHARED_EVENTS.BoardCreated, {
        boardType: 'spray',
        layoutId: wall.layoutId,
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
      dispatch({ type: 'PUBLISHED' });
      // Binds the wall as the active board and dismisses back to the tab the
      // flow was opened from, where the Climbs empty state takes over.
      await finish(wall.board);
    } catch (error) {
      reportError(error);
      dispatch({ type: 'PUBLISH_FAILED', message: extractGraphqlMessage(error) ?? t('sprayWizard.publish.failed') });
    }
  }, [state.draft, state.publish.running, publishVersionAsync, queryClient, builder, finish, t]);

  const leave = useCallback(() => {
    if (!leavingKeepsDraft(state)) {
      router.back();
      return;
    }
    Alert.alert(t('sprayWizard.leave.title'), t('sprayWizard.leave.body'), [
      { text: t('sprayWizard.leave.stay'), style: 'cancel' },
      { text: t('sprayWizard.leave.go'), onPress: () => router.back() },
    ]);
  }, [state, router, t]);

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

        {state.step === 'meta' ? (
          <>
            <Text variant="title3">{t('sprayWizard.meta.title')}</Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('sprayWizard.meta.body')}
            </Text>

            <BoardIdentityFields builder={builder} namePlaceholder={t('sprayWizard.meta.namePlaceholder')} />

            <SectionLabel>{t('sprayWizard.meta.angle')}</SectionLabel>
            <BuilderTextInput
              value={builder.angleText}
              onChangeText={builder.setAngleText}
              placeholder={String(MIN_SPRAY_ANGLE)}
              accessibilityLabel={t('sprayWizard.meta.angle')}
              keyboardType="number-pad"
              maxLength={2}
            />
            <Text variant="caption1" color={systemColors.tertiaryLabel}>
              {t('sprayWizard.meta.angleHint', { min: MIN_SPRAY_ANGLE, max: MAX_SPRAY_ANGLE })}
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

      <View
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
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
          <Button
            title={t('sprayWizard.upload.retry')}
            variant="filled"
            size="large"
            onPress={() => void runUpload()}
          />
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

        {state.step !== 'done' ? (
          <Button title={t('sprayWizard.back')} variant="text" onPress={goBack} disabled={isBusy(state)} />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

/** What the review bar says about where its candidates came from. */
function detectionSummary(
  state: { detection: { outcome: string; candidates: readonly unknown[] } },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (state.detection.outcome === 'unavailable') return t('sprayWizard.review.manualOnly');
  if (state.detection.outcome === 'failed') return t('sprayWizard.review.detectionFailed');
  if (state.detection.candidates.length === 0) return t('sprayWizard.review.nothingFound');
  return t('sprayWizard.review.found', { count: state.detection.candidates.length });
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
