export const userDataExportTypeDefs = /* GraphQL */ `
  enum UserDataExportFormat {
    boardsesh
    aurora
  }

  enum UserDataExportState {
    not_requested
    generating
    ready
    failed
    unavailable
  }

  type UserDataExportFile {
    format: UserDataExportFormat!
    filename: String!
    fileSize: Float
    exportedAt: String!
    expiresAt: String!
  }

  type UserDataExportStatus {
    boardType: String!
    period: String!
    status: UserDataExportState!
    files: [UserDataExportFile!]!
    refreshAt: String!
    requestedAt: String
    completedAt: String
    retryAt: String
    error: String
  }

  type UserDataExportDownloadLink {
    url: String!
    expiresAt: String!
    filename: String!
  }

  extend type Query {
    "The signed-in climber's recent cached export; defaults to this UTC ISO week."
    userDataExport(boardType: String!, period: String): UserDataExportStatus!
    "A five-minute private browser download; no user ID is accepted."
    userDataExportDownload(
      boardType: String!
      period: String!
      format: UserDataExportFormat!
    ): UserDataExportDownloadLink!
  }

  extend type Mutation {
    "Prepare a weekly climbing archive and, where supported, its Aurora companion."
    requestUserDataExport(boardType: String!): UserDataExportStatus!
  }
`;
