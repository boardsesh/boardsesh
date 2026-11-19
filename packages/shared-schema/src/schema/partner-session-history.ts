export const partnerSessionHistoryTypeDefs = /* GraphQL */ `
  extend type Query {
    """
    Resolve a partner export reference to a read-only completed session detail
    for its authenticated creator or a durable participant. This is a
    first-party history link, never an invitation or a join operation.
    """
    resolvePartnerSessionHistory(exportId: ID!): ID
  }
`;
