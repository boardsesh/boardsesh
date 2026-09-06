import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import {
  QA_PREVIEWS,
  SUBMIT_QA_VERDICT,
  type QaPreviewsQueryResponse,
  type SubmitQaVerdictMutationResponse,
  type SubmitQaVerdictMutationVariables,
} from '@boardsesh/graphql/operations/qa';
import {
  QA_PREVIEWS_MAX_PR_NUMBERS,
  type QaPreview,
  type QaVerdict,
  type QaVerdictKind,
} from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { getMobilePlatform, getNativeAppVersion } from '../feedback/use-submit-app-feedback';

export const QA_PREVIEWS_QUERY_KEY = 'qaPreviews';

/**
 * What the app knows about each PR behind a loadable `pr-<n>` branch: title,
 * author, risk, what to test, and this tester's own last verdict.
 *
 * The query key carries the PR numbers SORTED, so the pick screen (which lists
 * every branch) and the brief (which asks about one) share cache entries
 * deterministically rather than by however the caller happened to order them.
 * A short staleTime keeps a tester who bounces between the two from re-fetching,
 * while `retry: 1` keeps a GitHub outage from stalling the screen — the list
 * renders bare `pr-N` rows in that case, because testing must never be blocked
 * on metadata.
 */
export function useQaPreviews(prNumbers: number[], options?: { enabled?: boolean; includeBuilding?: boolean }) {
  // Trimmed BEFORE the sort, so what survives is the head of the caller's own
  // order (the pick screen passes its branches freshest first) rather than the
  // lowest PR numbers. The backend rejects an over-long list outright, and a
  // rejection costs every row its title, risk and plan — so overshooting the
  // bound has to cost the oldest previews their metadata, nothing more.
  const sortedPrNumbers = prNumbers.slice(0, QA_PREVIEWS_MAX_PR_NUMBERS).sort((left, right) => left - right);
  const includeBuilding = options?.includeBuilding ?? false;
  return useQuery({
    queryKey: [QA_PREVIEWS_QUERY_KEY, sortedPrNumbers, includeBuilding],
    queryFn: async (): Promise<QaPreview[]> => {
      const response = await getHttpClient().request<QaPreviewsQueryResponse>(QA_PREVIEWS, {
        prNumbers: sortedPrNumbers,
        includeBuilding,
      });
      return response.qaPreviews;
    },
    // An empty list is normally nothing to ask about — except with
    // `includeBuilding`, where "no branches published yet" is exactly when the
    // server has something to add.
    enabled: (options?.enabled ?? true) && (sortedPrNumbers.length > 0 || includeBuilding),
    staleTime: 60_000,
    retry: 1,
  });
}

/** What the verdict sheet collects; every other field is device context. */
export type QaVerdictSubmission = {
  prNumber: number;
  branch: string;
  verdict: QaVerdictKind;
  comment: string | null;
};

/**
 * File a verdict on the preview the tester just ran. The bundle identity
 * (`updateId`, `runtimeVersion`, `bundleCreatedAt`) and the handset
 * (`deviceModel`, `osVersion`) ride along so the GitHub comment can say what
 * was tested and where — and so a verdict filed against a bundle older than the
 * PR's head is visible as such rather than silently trusted.
 */
export function useSubmitQaVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (submission: QaVerdictSubmission): Promise<QaVerdict> => {
      const variables: SubmitQaVerdictMutationVariables = {
        input: {
          prNumber: submission.prNumber,
          branch: submission.branch,
          verdict: submission.verdict,
          comment: submission.comment,
          platform: getMobilePlatform(),
          // The handset, so a PR author reading the comment knows an iPhone 17
          // Pro pass says nothing about a Pixel. Null on a simulator without a
          // model name and in the browser.
          deviceModel: Device.modelName,
          osVersion: Device.osVersion,
          appVersion: getNativeAppVersion(),
          updateId: Updates.updateId ?? null,
          runtimeVersion: Updates.runtimeVersion ?? null,
          bundleCreatedAt: Updates.createdAt?.toISOString() ?? null,
        },
      };
      const response = await getHttpClient().request<SubmitQaVerdictMutationResponse>(SUBMIT_QA_VERDICT, variables);
      return response.submitQaVerdict;
    },
    onSuccess: () => {
      // Every cached preview list carries `myLatestVerdict`, so they are all
      // stale the moment one lands — the pick screen's "You approved" chip is
      // read straight off it.
      void queryClient.invalidateQueries({ queryKey: [QA_PREVIEWS_QUERY_KEY] });
    },
  });
}
