export const oauthClientsTypeDefs = /* GraphQL */ `
  """
  Where an app's OAuth redirect lands. WEB apps use https:// redirect URIs only;
  NATIVE apps may also use http://127.0.0.1 or http://[::1] and private-use
  schemes such as com.example.app:/oauth/boardsesh. See docs/partner-api.md.
  """
  enum OAuthClientApplicationType {
    WEB
    NATIVE
  }

  """
  How an app authenticates at the token endpoint. NONE is a public app (no
  secret, PKCE protects the code); the other two are confidential apps that send
  a client secret by HTTP Basic or in the form body.
  """
  enum OAuthClientAuthMethod {
    NONE
    CLIENT_SECRET_BASIC
    CLIENT_SECRET_POST
  }

  "An app a developer registered for the Boardsesh API. Never carries its secret."
  type OAuthClient {
    clientId: ID!
    "Shown on the consent screen."
    name: String!
    "Who makes the app: the consent screen's Made by line. Null only for an app registered before publishers were recorded."
    publisherName: String
    homepageUrl: String
    privacyPolicyUrl: String!
    applicationType: OAuthClientApplicationType!
    tokenEndpointAuthMethod: OAuthClientAuthMethod!
    "Matched as exact strings, except the port of a loopback redirect."
    redirectUris: [String!]!
    "ISO 8601."
    createdAt: String!
    "ISO 8601 when Boardsesh suspended the app, otherwise null. A suspended app gets no tokens."
    suspendedAt: String
    "Why the app was suspended, written for the developer."
    suspensionReason: String
    "Most climbers connected at once."
    maxActiveConnections: Int!
    "Most new climber connections per day."
    maxNewConnectionsPerDay: Int!
    "Climbers connected now. Deleting the app disconnects every one of them."
    activeConnections: Int!
  }

  "An app with a secret that is shown this once and can never be read again."
  type OAuthClientCredentials {
    client: OAuthClient!
    "Null for a public app."
    clientSecret: String
  }

  input CreateOAuthClientInput {
    "3 to 50 characters. Names of Boardsesh, Aurora and board brands are refused."
    name: String!
    "The person or company that makes the app. Same rules as name."
    publisherName: String!
    "https:// only."
    homepageUrl: String
    "https:// only."
    privacyPolicyUrl: String!
    applicationType: OAuthClientApplicationType!
    tokenEndpointAuthMethod: OAuthClientAuthMethod!
    "1 to 10."
    redirectUris: [String!]!
    "The developer terms version the developer accepted. Must equal the current version, or registration is refused."
    acceptedTermsVersion: String!
  }

  "Fields left out keep their value. A null homepageUrl removes it; publisherName can change but never be removed. The app type and auth method never change."
  input UpdateOAuthClientInput {
    clientId: ID!
    name: String
    publisherName: String
    homepageUrl: String
    privacyPolicyUrl: String
    redirectUris: [String!]
  }

  extend type Query {
    """
    The signed-in developer's apps. Developer apps answer NOT_FOUND while partner
    OAuth is off, and only allowlisted developers may use them.
    """
    myOAuthClients: [OAuthClient!]!
  }

  extend type Mutation {
    "Register an app. Returns its client ID and, for a confidential app, a secret shown once."
    createOAuthClient(input: CreateOAuthClientInput!): OAuthClientCredentials!
    "Edit the signed-in developer's app."
    updateOAuthClient(input: UpdateOAuthClientInput!): OAuthClient!
    "Replace a confidential app's secret. The old secret stops working at once."
    rotateOAuthClientSecret(clientId: ID!): OAuthClientCredentials!
    "Delete the signed-in developer's app and end every climber connection to it. False when there was no such app."
    deleteOAuthClient(clientId: ID!): Boolean!
  }
`;
