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
        lastMessageAt
        lastMessagePreview
        needsReply
        status
        resolvedAt
        resolvedBy
        githubIssueNumber
        githubIssueUrl
        releaseContext {
          channel
          branch
          updateId
          runtimeVersion
          isEmbeddedLaunch
          automaticCanary
          canaryCheckedAt
        }
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
        screenshotUrls
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
      lastMessageAt
      lastMessagePreview
      needsReply
      status
      resolvedAt
      resolvedBy
      githubIssueNumber
      githubIssueUrl
      releaseContext {
        channel
        branch
        updateId
        runtimeVersion
        isEmbeddedLaunch
        automaticCanary
        canaryCheckedAt
      }
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

export const MY_APP_BUG_REPORTS = gql`
  query MyAppBugReports($input: AppBugReportsInput) {
    myAppBugReports(input: $input) {
      reports {
        id
        comment
        createdAt
        status
        screenshotUrls
        githubIssueNumber
        githubIssueUrl
        canReply
        lastMessageAt
        lastMessagePreview
      }
      hasMore
      endCursor
    }
  }
`;
export const APP_BUG_REPORT = gql`
  query AppBugReport($id: ID!) {
    appBugReport(id: $id) {
      id
      comment
      createdAt
      status
      screenshotUrls
      githubIssueNumber
      githubIssueUrl
      canReply
      lastMessageAt
      lastMessagePreview
    }
  }
`;
export const APP_BUG_REPORT_MESSAGES = gql`
  query AppBugReportMessages($input: AppBugReportMessagesInput!) {
    appBugReportMessages(input: $input) {
      messages {
        id
        reportId
        body
        authorRole
        deliveryStatus
        createdAt
      }
      hasMore
      endCursor
    }
  }
`;
export const SEND_APP_BUG_REPORT_MESSAGE = gql`
  mutation SendAppBugReportMessage($input: SendAppBugReportMessageInput!) {
    sendAppBugReportMessage(input: $input) {
      id
      reportId
      body
      authorRole
      deliveryStatus
      createdAt
    }
  }
`;
export type MyAppBugReportsQueryVariables = { input?: import('@boardsesh/shared-schema').AppBugReportsInput | null };
export type MyAppBugReportsQueryResponse = {
  myAppBugReports: import('@boardsesh/shared-schema').AppBugReportConnection;
};
export type AppBugReportQueryVariables = { id: string };
export type AppBugReportQueryResponse = { appBugReport: import('@boardsesh/shared-schema').AppBugReport | null };
export type AppBugReportMessagesQueryVariables = {
  input: import('@boardsesh/shared-schema').AppBugReportMessagesInput;
};
export type AppBugReportMessagesQueryResponse = {
  appBugReportMessages: import('@boardsesh/shared-schema').AppBugReportMessageConnection;
};
export type SendAppBugReportMessageMutationVariables = {
  input: import('@boardsesh/shared-schema').SendAppBugReportMessageInput;
};
export type SendAppBugReportMessageMutationResponse = {
  sendAppBugReportMessage: import('@boardsesh/shared-schema').AppBugReportMessage;
};

export const RETRY_APP_BUG_REPORT_MESSAGE = gql`
  mutation RetryAppBugReportMessage($id: ID!) {
    retryAppBugReportMessage(id: $id) {
      id
      reportId
      body
      authorRole
      deliveryStatus
      createdAt
    }
  }
`;
export type RetryAppBugReportMessageMutationVariables = { id: string };
export type RetryAppBugReportMessageMutationResponse = {
  retryAppBugReportMessage: import('@boardsesh/shared-schema').AppBugReportMessage;
};

export const APP_BUG_REPORT_CHANGED = gql`
  subscription AppBugReportChanged {
    appBugReportChanged {
      reportId
    }
  }
`;
export type AppBugReportChangedSubscriptionResponse = {
  appBugReportChanged: import('@boardsesh/shared-schema').AppBugReportChangedEvent;
};
