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
import { extractGraphqlMessage, isGraphqlValidationFailedError } from '../../lib/graphql/extract-error-message';
import { fetchSprayWallVersions, mySprayWallsQueryKey } from '../../lib/spray/use-create-spray-wall';
import { sprayWallWithVersionsQueryKey } from '../../lib/spray/use-spray-wall-reset';
import {
  fetchSprayWallRenderData,
  invalidateSprayWallRenderData,
  registerRenderData,
} from '../../lib/spray/spray-wall-loader';
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
/** Editing keeps the active board and visibility intact; leaving keeps its draft. */
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
      if (!mountedRef.current) return;
      setFailure(error);
      setStatus('failed');
    } finally {
      busyRef.current = false;
    }
  }, []);

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
      await invalidateSprayWallRenderData(queryClient, prepared.wallUuid, prepared.layoutId);
      const publishedRenderData = await fetchSprayWallRenderData(queryClient, prepared.wallUuid);
      // Publishing preserves the draft's number. A later published version is
      // also valid if another editor publishes while this reload is in flight.
      if (
        !publishedRenderData ||
        publishedRenderData.wall.uuid !== prepared.wallUuid ||
        publishedRenderData.versionNumber < prepared.versionNumber ||
        !registerRenderData(prepared.layoutId, publishedRenderData)
      ) {
        throw new Error('Published wall refresh was unavailable');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sprayWallWithVersionsQueryKey(prepared.wallUuid) }),
        queryClient.invalidateQueries({ queryKey: mySprayWallsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ['searchClimbs'] }),
      ]);
      if (!mountedRef.current) return;
      setFinished(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setFailure(error);
      setStatus('failed');
    } finally {
      busyRef.current = false;
    }
  }, [queryClient]);

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

  const failureText =
    failure instanceof SprayHoldMaintenanceError
      ? failure.reason === 'unavailable'
        ? t('sprayMaintenance.unavailable')
        : failure.reason === 'nothingPublished'
          ? t('sprayMaintenance.nothingPublished')
          : t('sprayMaintenance.draftUnavailable')
      : isGraphqlValidationFailedError(failure)
        ? t('sprayMaintenance.temporarilyUnavailable')
        : (extractGraphqlMessage(failure) ??
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

  return (
    <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
      {status === 'failed' ? (
        <>
          <Text variant="headline" style={styles.message}>
            {failureText}
          </Text>
          <Button title={t('sprayMaintenance.retry')} onPress={() => void (draft ? finish() : prepare())} />
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

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[6] },
  message: { textAlign: 'center' },
});
