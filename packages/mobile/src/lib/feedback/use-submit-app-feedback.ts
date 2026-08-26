import { Platform } from 'react-native';
import * as Application from 'expo-application';
import { usePathname } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import {
  SUBMIT_APP_FEEDBACK,
  type SubmitAppFeedbackMutationResponse,
  type SubmitAppFeedbackMutationVariables,
} from '@boardsesh/graphql/operations';
import type { SubmitAppFeedbackInput } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { useActiveBoard } from '../graphql/use-active-board';
import { useQueue, useQueueSessionId } from '../../providers/queue-provider';
import { buildMobileFeedbackEnrichment } from './feedback-enrichment';

export type MobileSubmitAppFeedbackPayload = Omit<
  SubmitAppFeedbackInput,
  'platform' | 'appVersion' | 'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'angle' | 'context'
>;

/**
 * The platform string every backend report/verdict payload carries. Exported so
 * the crowdsourced-QA verdict fills the same field the same way — one mapping,
 * so `web` can't creep in on one path and not the other.
 */
export function getMobilePlatform(): SubmitAppFeedbackInput['platform'] {
  return Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';
}

/** `1.2.3 (45)` — the marketing version plus the build, as the backend shows it. */
export function getNativeAppVersion(): string | null {
  const nativeVersion = Application.nativeApplicationVersion;
  const nativeBuild = Application.nativeBuildVersion;
  if (nativeVersion && nativeBuild) return `${nativeVersion} (${nativeBuild})`;
  return nativeVersion ?? nativeBuild ?? null;
}

async function submitMobileAppFeedback(payload: SubmitAppFeedbackInput): Promise<boolean> {
  const variables: SubmitAppFeedbackMutationVariables = { input: payload };
  const response = await getHttpClient().request<SubmitAppFeedbackMutationResponse>(SUBMIT_APP_FEEDBACK, variables);
  return response.submitAppFeedback;
}

export function useSubmitMobileAppFeedback() {
  const activeBoardQuery = useActiveBoard();
  const queueContext = useQueue();
  const { sessionId } = useQueueSessionId();
  const pathname = usePathname();

  return useMutation({
    mutationFn: (payload: MobileSubmitAppFeedbackPayload): Promise<boolean> => {
      const enrichment = buildMobileFeedbackEnrichment({
        activeBoard: activeBoardQuery.data,
        currentClimbQueueItem: queueContext.state.currentClimbQueueItem,
        sessionId,
        pathname,
      });
      return submitMobileAppFeedback({
        ...payload,
        ...enrichment,
        platform: getMobilePlatform(),
        appVersion: getNativeAppVersion(),
      });
    },
  });
}
