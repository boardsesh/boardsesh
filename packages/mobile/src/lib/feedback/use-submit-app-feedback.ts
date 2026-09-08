import { Platform } from 'react-native';
import * as Application from 'expo-application';
import type { RefObject } from 'react';
import type { FeedbackMetadataReader } from './FeedbackMetadataCollector';
import { useMutation } from '@tanstack/react-query';
import {
  SUBMIT_APP_FEEDBACK,
  type SubmitAppFeedbackMutationResponse,
  type SubmitAppFeedbackMutationVariables,
} from '@boardsesh/graphql/operations';
import type { SubmitAppFeedbackInput } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
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

export function useSubmitMobileAppFeedback(readerRef: RefObject<FeedbackMetadataReader | null>) {
  return useMutation({
    mutationFn: (payload: MobileSubmitAppFeedbackPayload): Promise<boolean> => {
      const readMetadata = readerRef.current;
      if (!readMetadata) return Promise.reject(new Error('Feedback metadata is not ready'));
      // Read at mutation time, after screenshot upload. The bridge stays mounted
      // throughout submission, even if the reporter dismisses the native sheet.
      const enrichment = buildMobileFeedbackEnrichment(readMetadata());
      return submitMobileAppFeedback({
        ...payload,
        ...enrichment,
        platform: getMobilePlatform(),
        appVersion: getNativeAppVersion(),
      });
    },
  });
}
