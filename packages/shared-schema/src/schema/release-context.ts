export const releaseContextTypeDefs = /* GraphQL */ `
  "Identity of the running bundle; excludes a pending download or requested track."
  input ReleaseContextInput {
    channel: String
    branch: String
    updateId: String
    runtimeVersion: String
    isEmbeddedLaunch: Boolean
  }

  input MobileReleaseStatusInput {
    platform: String!
    channel: String
    branch: String
    updateId: String
    runtimeVersion: String
    isEmbeddedLaunch: Boolean
  }

  "Running identity with backend-verified current automatic canary membership."
  type ReleaseContext {
    channel: String
    branch: String
    updateId: String
    runtimeVersion: String
    isEmbeddedLaunch: Boolean
    "Null when current rollout membership could not be checked."
    automaticCanary: Boolean
    canaryCheckedAt: String
  }

  "Release diagnostics attached to a report reason, visible only to scoped admins."
  type ProposalReportReleaseContext {
    commentUuid: ID!
    releaseContext: ReleaseContext!
  }
`;
