import { gql } from 'graphql-request';
import type { MobileReleaseStatusInput, ReleaseContext, ProposalReportReleaseContext } from '@boardsesh/shared-schema';

export const MOBILE_RELEASE_STATUS = gql`
  query MobileReleaseStatus($input: MobileReleaseStatusInput!) {
    mobileReleaseStatus(input: $input) {
      channel
      branch
      updateId
      runtimeVersion
      isEmbeddedLaunch
      automaticCanary
      canaryCheckedAt
    }
  }
`;

export type MobileReleaseStatusQueryVariables = { input: MobileReleaseStatusInput };
export type MobileReleaseStatusQueryResponse = { mobileReleaseStatus: ReleaseContext };

export const PROPOSAL_REPORT_RELEASE_CONTEXTS = gql`
  query ProposalReportReleaseContexts($proposalUuid: ID!) {
    proposalReportReleaseContexts(proposalUuid: $proposalUuid) {
      commentUuid
      releaseContext {
        channel
        branch
        updateId
        runtimeVersion
        isEmbeddedLaunch
        automaticCanary
        canaryCheckedAt
      }
    }
  }
`;

export type ProposalReportReleaseContextsQueryVariables = { proposalUuid: string };
export type ProposalReportReleaseContextsQueryResponse = {
  proposalReportReleaseContexts: ProposalReportReleaseContext[];
};
