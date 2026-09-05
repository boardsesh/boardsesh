// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type {
  AdminAppFeedbackInput,
  AdminAppFeedbackResult,
  AppFeedbackReport,
  SubmitAppFeedbackInput,
  UpdateAppFeedbackStatusInput,
} from '@boardsesh/shared-schema';

export const SUBMIT_APP_FEEDBACK = gql`
  mutation SubmitAppFeedback($input: SubmitAppFeedbackInput!) {
    submitAppFeedback(input: $input)
  }
`;

export type SubmitAppFeedbackMutationVariables = {
  input: SubmitAppFeedbackInput;
};

export type SubmitAppFeedbackMutationResponse = {
  submitAppFeedback: boolean;
};

// ============================================
// Admin feedback dashboard
// ============================================
// The report field set is written inline in each operation rather than shared
// via a `${const}` interpolation: graphql-tag-pluck (codegen) can't resolve a
// runtime interpolation, and one in this file would drop every sibling document
// (incl. SubmitAppFeedback) from the generated client.

export const ADMIN_APP_FEEDBACK = gql`
  query AdminAppFeedback($input: AdminAppFeedbackInput) {
    adminAppFeedback(input: $input) {
      reports {
        id
        source
        rating
        comment
        platform
        appVersion
        boardName
        angle
        contactConsent
        createdAt
        status
        resolvedAt
        resolvedBy
        githubIssueNumber
        githubIssueUrl
        reporter {
          userId
          email
          name
        }
        context {
          climbUuid
          climbName
          difficulty
          sessionId
          sessionName
          url
          userAgent
        }
      }
      totalCount
      hasMore
      statusCounts {
        new
        inProgress
        resolved
        wontFix
      }
    }
  }
`;

export const UPDATE_APP_FEEDBACK_STATUS = gql`
  mutation UpdateAppFeedbackStatus($input: UpdateAppFeedbackStatusInput!) {
    updateAppFeedbackStatus(input: $input) {
      id
      source
      rating
      comment
      platform
      appVersion
      boardName
      angle
      contactConsent
      createdAt
      status
      resolvedAt
      resolvedBy
      githubIssueNumber
      githubIssueUrl
      reporter {
        userId
        email
        name
      }
      context {
        climbUuid
        climbName
        difficulty
        sessionId
        sessionName
        url
        userAgent
      }
    }
  }
`;

export type AdminAppFeedbackQueryVariables = {
  input?: AdminAppFeedbackInput | null;
};

export type AdminAppFeedbackQueryResponse = {
  adminAppFeedback: AdminAppFeedbackResult;
};

export type UpdateAppFeedbackStatusMutationVariables = {
  input: UpdateAppFeedbackStatusInput;
};

export type UpdateAppFeedbackStatusMutationResponse = {
  updateAppFeedbackStatus: AppFeedbackReport;
};
