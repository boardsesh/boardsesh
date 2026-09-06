import { gql } from 'graphql-request';
import type { QaPreview, QaVerdict, SubmitQaVerdictInput } from '@boardsesh/shared-schema';

// Crowdsourced QA (docs/crowdsourced-qa.md): the mobile app lists a tester's
// loadable `pr-<n>` OTA branches, asks the backend what each PR is and what to
// test, and files the verdict back through submitQaVerdict.

export const QA_PREVIEWS = gql`
  query QaPreviews($prNumbers: [Int!]!, $includeBuilding: Boolean) {
    qaPreviews(prNumbers: $prNumbers, includeBuilding: $includeBuilding) {
      prNumber
      branch
      title
      url
      author
      isDraft
      headSha
      headCommittedAt
      updatedAt
      risk
      riskReason
      testPlan
      testPlanSteps
      otaBuild
      labels {
        name
        color
      }
      myLatestVerdict {
        id
        prNumber
        branch
        verdict
        comment
        headSha
        createdAt
        githubCommentUrl
        screenshotUrls
      }
    }
  }
`;

export type QaPreviewsQueryVariables = {
  prNumbers: number[];
  /** Also return open PRs whose preview bundle is still publishing. */
  includeBuilding?: boolean;
};

export type QaPreviewsQueryResponse = {
  qaPreviews: QaPreview[];
};

export const SUBMIT_QA_VERDICT = gql`
  mutation SubmitQaVerdict($input: SubmitQaVerdictInput!) {
    submitQaVerdict(input: $input) {
      id
      prNumber
      branch
      verdict
      comment
      headSha
      createdAt
      githubCommentUrl
      screenshotUrls
    }
  }
`;

export type SubmitQaVerdictMutationVariables = {
  input: SubmitQaVerdictInput;
};

export type SubmitQaVerdictMutationResponse = {
  submitQaVerdict: QaVerdict;
};
