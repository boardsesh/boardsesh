export const moonBoardCollectionTypeDefs = /* GraphQL */ `
  input MoonBoardCollectionRowInput {
    lineNumber: Int!
    name: String!
    grade: String!
    setter: String
  }

  input MoonBoardCollectionPreviewInput {
    layoutId: Int!
    angle: Int!
    rows: [MoonBoardCollectionRowInput!]!
  }

  input MoonBoardCollectionImportInput {
    layoutId: Int!
    angle: Int!
    rows: [MoonBoardCollectionRowInput!]!
    playlistUuid: ID!
    playlistName: String!
    "Existing destination's database ID, paired with playlistUuid. Omit to create a private playlist."
    playlistId: ID
  }

  type MoonBoardCollectionMatch {
    lineNumber: Int!
    name: String!
    grade: String!
    climbUuid: String
    "matched, missing, ambiguous, or duplicate"
    status: String!
  }

  type MoonBoardCollectionPreview {
    rows: [MoonBoardCollectionMatch!]!
    matched: Int!
    missing: Int!
    ambiguous: Int!
    duplicates: Int!
  }

  type MoonBoardCollectionImportResult {
    playlistId: ID!
    playlistUuid: ID!
    imported: Int!
    skipped: Int!
    preview: MoonBoardCollectionPreview!
  }

  extend type Query {
    "Match exported MoonBoard problem names against the public catalogue without saving anything."
    previewMoonBoardCollectionImport(input: MoonBoardCollectionPreviewInput!): MoonBoardCollectionPreview!
  }

  extend type Mutation {
    "Save matched catalogue climbs to an owned private playlist. Rechecks matches at import time."
    importMoonBoardCollection(input: MoonBoardCollectionImportInput!): MoonBoardCollectionImportResult!
  }
`;
