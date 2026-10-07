import { registerNotificationDevice } from '../../notifications/device-registration';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_SPRAY_DETECTION,
  REQUEST_SPRAY_DETECTION,
  RETRY_SPRAY_DETECTION,
} from '@boardsesh/graphql/operations/spray-detection';
import { isSprayDetectionPending, type SprayDetectionView } from '@boardsesh/shared-schema';
import { useIsOffline } from '../../hooks/use-is-offline';
import { getHttpClient } from '../graphql/client';

/** The server owns the job. Remounting resumes it without uploading the photo again. */
export function useSprayDetection(wallUuid: string, versionId: string) {
  const queryClient = useQueryClient();
  const focused = useIsFocused();
  const offline = useIsOffline();
  // Promise a push only once this device is registered for one: a binary
  // without push credentials (Android before FCM ships) never gets a token.
  const [pushReady, setPushReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    void registerNotificationDevice(true).then((registered) => {
      if (mounted) setPushReady(registered);
    });
    return () => {
      mounted = false;
    };
  }, []);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  const queryKey = ['spray-wall-detection', wallUuid, versionId] as const;
  const query = useQuery({
    queryKey,
    enabled: foreground && focused && !offline,
    queryFn: async () => {
      const client = getHttpClient();
      const response = await client.request<{ sprayWallDetectionForVersion: SprayDetectionView | null }>(
        GET_SPRAY_DETECTION,
        { wallUuid, versionId },
      );
      if (response.sprayWallDetectionForVersion) return response.sprayWallDetectionForVersion;
      const requested = await client.request<{ requestSprayWallDetection: SprayDetectionView }>(
        REQUEST_SPRAY_DETECTION,
        { input: { wallUuid, versionId } },
      );
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['sprayImportProgress'] });
      return requested.requestSprayWallDetection;
    },
    retry: false,
    refetchInterval: (current) =>
      !foreground || !focused || offline || (current.state.data && !isSprayDetectionPending(current.state.data.status))
        ? false
        : 2000,
    refetchIntervalInBackground: false,
  });
  const retry = useMutation({
    mutationFn: async () => {
      if (!query.data) {
        await query.refetch();
        return;
      }
      const response = await getHttpClient().request<{ retrySprayWallDetection: SprayDetectionView }>(
        RETRY_SPRAY_DETECTION,
        { id: query.data.id },
      );
      queryClient.setQueryData(queryKey, response.retrySprayWallDetection);
      void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
      void queryClient.invalidateQueries({ queryKey: ['sprayImportProgress'] });
    },
  });
  return { query, retry, offline, pushReady };
}
