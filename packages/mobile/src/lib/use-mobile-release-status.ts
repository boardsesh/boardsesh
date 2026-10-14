import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import {
  MOBILE_RELEASE_STATUS,
  type MobileReleaseStatusQueryResponse,
  type MobileReleaseStatusQueryVariables,
} from '@boardsesh/graphql/operations';
import type { ReleaseContext } from '@boardsesh/shared-schema';
import { getHttpClient } from './graphql/client';
import { readMobileReleaseContext } from './release-context';

export function useMobileReleaseStatus(): { releaseContext: ReleaseContext | null; isPending: boolean } {
  const runningRelease = readMobileReleaseContext();
  const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  const enabled = Boolean(
    Updates.isEnabled &&
    !runningRelease.isEmbeddedLaunch &&
    platform !== 'web' &&
    runningRelease.channel &&
    runningRelease.updateId &&
    runningRelease.runtimeVersion,
  );
  const status = useQuery({
    queryKey: [
      'mobileReleaseStatus',
      platform,
      runningRelease.channel,
      runningRelease.branch,
      runningRelease.updateId,
      runningRelease.runtimeVersion,
      runningRelease.isEmbeddedLaunch,
    ],
    queryFn: async ({ signal }): Promise<ReleaseContext> => {
      const variables: MobileReleaseStatusQueryVariables = { input: { ...runningRelease, platform } };
      const response = await getHttpClient().request<MobileReleaseStatusQueryResponse>({
        document: MOBILE_RELEASE_STATUS,
        variables,
        signal,
      });
      return response.mobileReleaseStatus;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: 1,
  });
  return {
    releaseContext: Updates.isEnabled
      ? (status.data ?? {
          ...runningRelease,
          automaticCanary: runningRelease.isEmbeddedLaunch === true || platform === 'web' ? false : null,
          canaryCheckedAt: null,
        })
      : null,
    isPending: enabled && status.isPending,
  };
}
