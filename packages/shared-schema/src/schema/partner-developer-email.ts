export const partnerDeveloperEmailTypeDefs = /* GraphQL */ `
  type PartnerDeveloperEmailStatus {
    email: String!
    verified: Boolean!
  }
  extend type Query {
    partnerDeveloperEmailStatus: PartnerDeveloperEmailStatus!
  }
  extend type Mutation {
    requestPartnerDeveloperEmail: Boolean!
    confirmPartnerDeveloperEmail(token: String!): Boolean!
  }
`;
