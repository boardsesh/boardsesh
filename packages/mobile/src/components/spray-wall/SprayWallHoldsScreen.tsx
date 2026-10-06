import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CREATE_SPRAY_WALL_VERSION, PUBLISH_SPRAY_WALL_VERSION } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallVersion } from '@boardsesh/graphql/generated/graphql';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayHoldEditorScreen, confirmDiscardSprayEdits } from '../outline-editor/SprayHoldEditorScreen';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { getHttpClient } from '../../lib/graphql/client';
import {
  extractGraphqlCode,
  extractGraphqlMessage,
  isGraphqlValidationFailedError,
  sprayWallLifecycleRefusal,
  sprayWallRefusalMeansStaleWall,
} from '../../lib/graphql/extract-error-message';
import { sprayWallLifecycleMessage } from '../../lib/spray/spray-lifecycle-copy';
import {
  fetchSprayWallVersions,
  mySprayWallsQueryKey,
  sprayWallWithVersionsQueryKey,
  useDiscardSprayWallVersion,
} from '../../lib/spray/use-create-spray-wall';
import { refreshPublishedSprayClimbs } from '../../lib/spray/refresh-published-spray-climbs';
import { BIND_STAGE_DEADLINE_MS, withDeadline } from '../../lib/spray/post-publish-bind';
import {
  fetchSprayWallRenderData,
  invalidateSprayWallRenderData,
  registerRenderData,
} from '../../lib/spray/spray-wall-loader';
import {
  findRegisteredSprayWallByUuid,
  refreshSprayWall,
  sprayWallRemovalGeneration,
  sprayWallViewerGeneration,
} from '../../lib/spray/spray-wall-registry';
import {
  prepareSprayHoldDraft,
  publishSprayHoldDraft,
  SprayHoldMaintenanceError,
  type PreparedSprayHoldDraft,
  type SprayHoldMaintenanceTransport,
} from '../../lib/spray/spray-hold-maintenance';

const maintenanceTransport: SprayHoldMaintenanceTransport = {
  fetchWall: fetchSprayWallVersions,
  createDraft: async (input) => {
    const response = await getHttpClient().request<{ createSprayWallVersion: SprayWallVersion }>(
      CREATE_SPRAY_WALL_VERSION,
      { input },
    );
    return response.createSprayWallVersion;
  },
  publishDraft: async (versionId) => {
    const response = await getHttpClient().request<{ publishSprayWallVersion: SprayWallVersion }>(
      PUBLISH_SPRAY_WALL_VERSION,
      { input: { versionId } },
    );
    return response.publishSprayWallVersion;
  },
};

type MaintenanceStatus = 'preparing' | 'editing' | 'publishing' | 'refreshing' | 'failed';

/**
 * A refusal that no retry can fix: the wall is archived, or its holds locked
 * when its first climb was published. The screen explains it and offers only
 * the way back.
 */
function isFinalRefusal(failure: unknown): boolean {
  if (failure instanceof SprayHoldMaintenanceError) {
    return failure.reason === 'archived' || failure.reason === 'holdsLocked';
  }
  return sprayWallRefusalMeansStaleWall(sprayWallLifecycleRefusal(failure));
}

/**
 * Editing keeps the active board and visibility intact; leaving keeps its draft.
 *
 * Refuses a wall whose holds are locked or which is archived before any draft is
 * opened (`prepareSprayHoldDraft`), so a deep link or a sheet that rendered
 * before the lock cannot reach the editor.
 */
export function SprayWallHoldsScreen({ wallUuid }: { wallUuid: string }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigation = useNavigation();
  // A param update must not repoint edits already in progress to a different wall.
  const requestedWallUuidRef = useRef(wallUuid);
  const [status, setStatus] = useState<MaintenanceStatus>('preparing');
  const [draft, setDraft] = useState<PreparedSprayHoldDraft | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorHandingOver, setEditorHandingOver] = useState(false);
  const [finished, setFinished] = useState(false);
  const draftRef = useRef<PreparedSprayHoldDraft | null>(null);
  const publishedRef = useRef(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const editorDirtyRef = useRef(false);
  const editorHandingOverRef = useRef(false);

  const returnToBoards = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/boards');
  }, [router]);

  // The wall's registry entry, refreshed when the server says this device's
  // picture of the wall is out of date (archived, or holds locked since).
  const refreshRegisteredWall = useCallback((failure: unknown) => {
    const stale =
      failure instanceof SprayHoldMaintenanceError
        ? failure.reason === 'archived' || failure.reason === 'holdsLocked'
        : sprayWallRefusalMeansStaleWall(sprayWallLifecycleRefusal(failure));
    if (!stale) return;
    const registered = findRegisteredSprayWallByUuid(requestedWallUuidRef.current);
    if (registered) refreshSprayWall(registered.layoutId);
  }, []);

  const prepare = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setFailure(null);
    setStatus('preparing');
    try {
      const prepared = await prepareSprayHoldDraft(requestedWallUuidRef.current, maintenanceTransport);
      if (!mountedRef.current) return;
      draftRef.current = prepared;
      setDraft(prepared);
      setStatus('editing');
    } catch (error) {
      refreshRegisteredWall(error);
      if (!mountedRef.current) return;
      setFailure(error);
      setStatus('failed');
    } finally {
      busyRef.current = false;
    }
  }, [refreshRegisteredWall]);

  useEffect(() => {
    mountedRef.current = true;
    void prepare();
    return () => {
      mountedRef.current = false;
    };
  }, [prepare]);

  const finish = useCallback(async () => {
    const prepared = draftRef.current;
    if (!prepared || busyRef.current) return;
    busyRef.current = true;
    const removalGeneration = sprayWallRemovalGeneration(prepared.layoutId);
    setFailure(null);
    try {
      if (!publishedRef.current) {
        setStatus('publishing');
        await publishSprayHoldDraft(prepared, maintenanceTransport);
        // Latched before refresh: a failed reload never retries this mutation.
        publishedRef.current = true;
      }
      if (!mountedRef.current) return;
      setStatus('refreshing');
      // Under one ceiling, in the same order as ever. While this runs the leave
      // guard holds every way out (`busyRef`), and both awaits can sit on a
      // query whose refetch is paused offline, so without a deadline the
      // "refreshing" spinner had no end and no exit. Past it the screen fails
      // into Retry (which skips the publish, latched above) and Back.
      const { renderData: publishedRenderData, viewerGeneration } = await withDeadline(
        (async () => {
          await invalidateSprayWallRenderData(queryClient, prepared.wallUuid, prepared.layoutId);
          // Noted before the fetch: the payload says whether THIS account can
          // edit the wall, and a registration that cannot say whose answer it
          // holds is registered as "cannot edit", which would take Edit off the
          // owner's own climbs for the rest of the revalidation window.
          const viewerGeneration = sprayWallViewerGeneration();
          const renderData = await fetchSprayWallRenderData(queryClient, prepared.wallUuid, viewerGeneration);
          return { renderData, viewerGeneration };
        })(),
        BIND_STAGE_DEADLINE_MS,
        () => new Error('Published wall refresh timed out'),
      );
      // Publishing preserves the draft's number. A later published version is
      // also valid if another editor publishes while this reload is in flight.
      if (
        !publishedRenderData ||
        publishedRenderData.wall.uuid !== prepared.wallUuid ||
        publishedRenderData.versionNumber < prepared.versionNumber ||
        !registerRenderData(prepared.layoutId, publishedRenderData, undefined, viewerGeneration, removalGeneration)
      ) {
        throw new Error('Published wall refresh was unavailable');
      }
      // Started, not awaited: the wall is published and registered above, so
      // nothing left here decides whether the climber may leave. These are
      // invalidations over queries with live subscribers, and under
      // `offlineFirst` a refetch whose first try fails offline pauses its
      // retries — and this promise with them — until the app is back online.
      // None of them rejects: `invalidateQueries` never throws by default and
      // `refreshPublishedSprayClimbs` reports its own failures.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: sprayWallWithVersionsQueryKey(prepared.wallUuid) }),
        queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey }),
        refreshPublishedSprayClimbs(queryClient, prepared.layoutId),
      ]);
      if (!mountedRef.current) return;
      setFinished(true);
    } catch (error) {
      refreshRegisteredWall(error);
      if (!mountedRef.current) return;
      setFailure(error);
      setStatus('failed');
    } finally {
      busyRef.current = false;
    }
  }, [queryClient, refreshRegisteredWall]);

  // A new-photo draft the retired in-place reset left on this wall. Discarding
  // it keeps the wall and its climbs; only the photo goes.
  const discardLeftover = useDiscardSprayWallVersion(wallUuid);
  const discardLeftoverAsync = discardLeftover.mutateAsync;
  const [discardFailed, setDiscardFailed] = useState(false);
  const discardLeftoverPhoto = useCallback(
    async (versionId: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setDiscardFailed(false);
      try {
        await discardLeftoverAsync(versionId);
      } catch {
        if (mountedRef.current) setDiscardFailed(true);
        busyRef.current = false;
        return;
      }
      busyRef.current = false;
      if (mountedRef.current) void prepare();
    },
    [discardLeftoverAsync, prepare],
  );

  const onDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);
  const onHandoverChange = useCallback((handingOver: boolean) => {
    editorHandingOverRef.current = handingOver;
    setEditorHandingOver(handingOver);
  }, []);
  const onCommitted = useCallback(() => {
    // Publish even if this save changes no holds: a resumed draft can already
    // contain the edits to publish, so save counts do not gate completion.
    editorDirtyRef.current = false;
    setEditorDirty(false);
    void finish();
  }, [finish]);

  usePreventRemove(
    !finished &&
      (status === 'preparing' ||
        status === 'publishing' ||
        status === 'refreshing' ||
        editorDirty ||
        editorHandingOver),
    ({ data: { action } }) => {
      if (busyRef.current || editorHandingOverRef.current) return;
      confirmDiscardSprayEdits(
        editorDirtyRef.current,
        () => {
          // A Save started while the dialog was up still owns the screen.
          if (busyRef.current || editorHandingOverRef.current) return;
          navigation.dispatch(action);
        },
        {
          title: t('sprayMaintenance.leave.title'),
          message: t('sprayMaintenance.leave.body'),
          keep: t('sprayMaintenance.leave.stay'),
          discard: t('sprayMaintenance.leave.discard'),
        },
      );
    },
  );

  useEffect(() => {
    // Let native-stack remove its dismissal guard before requesting the pop.
    if (finished) returnToBoards();
  }, [finished, returnToBoards]);

  if (status === 'editing' && draft) {
    return (
      <SprayHoldEditorScreen
        {...draft}
        primaryLabel={t('sprayMaintenance.publish')}
        onCommitted={onCommitted}
        onDirtyChange={onDirtyChange}
        onHandoverChange={onHandoverChange}
      />
    );
  }

  const graphqlMessage = extractGraphqlMessage(failure);
  const lifecycleRefusal = sprayWallLifecycleRefusal(failure);
  // Yoga input-coercion errors have no code and can include request variables.
  // Only coded backend guidance is suitable for displaying verbatim.
  const schemaOrUncodedError =
    isGraphqlValidationFailedError(failure) || (graphqlMessage !== null && extractGraphqlCode(failure) === null);
  const failureText =
    failure instanceof SprayHoldMaintenanceError
      ? maintenanceFailureText(failure.reason, t)
      : lifecycleRefusal
        ? sprayWallLifecycleMessage(lifecycleRefusal, t)
        : schemaOrUncodedError
          ? t('sprayMaintenance.temporarilyUnavailable')
          : (graphqlMessage ??
            (draft
              ? publishedRef.current
                ? t('sprayMaintenance.refreshFailed')
                : t('sprayMaintenance.publishFailed')
              : t('sprayMaintenance.loadFailed')));
  const workingText =
    status === 'preparing'
      ? t('sprayMaintenance.preparing')
      : status === 'publishing'
        ? t('sprayMaintenance.publishing')
        : t('sprayMaintenance.refreshing');
  const leftoverVersionId =
    failure instanceof SprayHoldMaintenanceError && failure.reason === 'leftoverPhotoDraft'
      ? failure.leftoverVersionId
      : null;
  const finalRefusal = isFinalRefusal(failure);

  return (
    <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
      {status === 'failed' ? (
        <>
          {finalRefusal && failure instanceof SprayHoldMaintenanceError && failure.reason === 'holdsLocked' ? (
            <Text variant="headline" style={styles.message}>
              {t('mobile.boardDetail.spray.holdsLocked')}
            </Text>
          ) : null}
          <Text variant={finalRefusal ? 'body' : 'headline'} style={styles.message}>
            {failureText}
          </Text>
          {discardFailed ? (
            <Text variant="subheadline" style={styles.message}>
              {t('sprayMaintenance.discardLeftoverFailed')}
            </Text>
          ) : null}
          {leftoverVersionId ? (
            <Button
              title={t('sprayMaintenance.discardLeftover')}
              onPress={() => void discardLeftoverPhoto(leftoverVersionId)}
              loading={discardLeftover.isPending}
              disabled={discardLeftover.isPending}
            />
          ) : finalRefusal ? null : (
            <Button title={t('sprayMaintenance.retry')} onPress={() => void (draft ? finish() : prepare())} />
          )}
          <Button title={t('sprayWizard.back')} variant="text" onPress={returnToBoards} />
        </>
      ) : (
        <>
          <ActivityIndicator size="large" />
          <Text variant="subheadline" style={styles.message}>
            {workingText}
          </Text>
        </>
      )}
    </View>
  );
}

/** The sentence for each maintenance failure. Literal keys, for the i18n orphan check. */
function maintenanceFailureText(reason: SprayHoldMaintenanceError['reason'], t: (key: string) => string): string {
  switch (reason) {
    case 'unavailable':
      return t('sprayMaintenance.unavailable');
    case 'nothingPublished':
      return t('sprayMaintenance.nothingPublished');
    case 'archived':
      return t('sprayWallErrors.archived');
    case 'holdsLocked':
      return t('mobile.boardDetail.spray.holdsLockedHint');
    case 'leftoverPhotoDraft':
      return t('sprayMaintenance.leftoverPhoto');
    case 'draftUnavailable':
      return t('sprayMaintenance.draftUnavailable');
  }
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[6] },
  message: { textAlign: 'center' },
});
