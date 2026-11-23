export const boardMergesTypeDefs = /* GraphQL */ `
  type BoardMergeReport {
    reason: String!
    createdAt: String!
  }
  type BoardMergeRequest {
    reports: [BoardMergeReport!]!
    uuid: ID!
    status: String!
    reason: String!
    canonicalBoardUuid: ID!
    boardUuids: [ID!]!
    boards: [UserBoard!]!
    createdAt: String!
    canResolve: Boolean!
    resolutionReason: String
  }
  type BoardMergeCandidateConnection {
    boards: [UserBoard!]!
    hasMore: Boolean!
  }
  type BoardMergePreview {
    boards: [UserBoard!]!
    suggestedCanonicalBoardUuid: ID!
    canMerge: Boolean!
    version: String!
    reason: String
  }
  type BoardMergeRequestConnection {
    requests: [BoardMergeRequest!]!
    hasMore: Boolean!
  }
  type BoardMergeResult {
    canonicalBoardUuid: ID!
  }
  input BoardMergeCandidatesInput {
    boardUuid: ID
    gymUuid: ID
    query: String
    limit: Int
    offset: Int
  }
  input BoardMergeRequestsInput {
    gymUuid: ID
    boardType: String
    status: String
    limit: Int
    offset: Int
  }
  input RequestBoardMergeInput {
    boardUuids: [ID!]!
    canonicalBoardUuid: ID!
    reason: String!
  }
  input MergeBoardsInput {
    boardUuids: [ID!]!
    canonicalBoardUuid: ID!
    version: String!
    reason: String!
  }
  input ResolveBoardMergeRequestInput {
    requestUuid: ID!
    approve: Boolean!
    canonicalBoardUuid: ID
    version: String
    reason: String
  }
  extend type Query {
    boardMergeCandidates(input: BoardMergeCandidatesInput): BoardMergeCandidateConnection!
    boardMergePreview(boardUuids: [ID!]!): BoardMergePreview!
    boardMergeRequests(input: BoardMergeRequestsInput): BoardMergeRequestConnection!
  }
  extend type Mutation {
    requestBoardMerge(input: RequestBoardMergeInput!): BoardMergeRequest!
    mergeBoards(input: MergeBoardsInput!): BoardMergeResult!
    resolveBoardMergeRequest(input: ResolveBoardMergeRequestInput!): BoardMergeRequest!
  }
`;
