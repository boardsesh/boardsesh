export const connectedAppsTypeDefs = /* GraphQL */ `
  "An app the signed-in climber connected to their account (docs/integration-platform.md, Connected apps)."
  type ConnectedApp {
    "Pass to disconnectApp."
    connectionId: ID!
    "The app's registered name. Null when it has none."
    name: String
    """
    Who makes the app, as its developer registered it. Null until apps carry a
    publisher name, and never the developer account's own name.
    """
    publisherName: String
    """
    What the climber allowed, as OAuth scope strings (profile:read, logbook:read,
    offline_access, or one added later). Clients word them in the climber's language.
    """
    scopes: [String!]!
    "ISO 8601. When the app first used its access, or first used it again after a reconnect."
    connectedAt: String!
    "ISO 8601. The app's latest call to the API, to within an hour. Null until it makes one."
    lastUsedAt: String
    "True while Boardsesh has suspended the app. It reads nothing until it is restored."
    suspended: Boolean!
  }

  type ConnectedApps {
    "Live connections, the most recently connected first."
    apps: [ConnectedApp!]!
    """
    False while partner apps are switched off (PARTNER_OAUTH_MODE off): no app can
    connect, though connections made before still list here and can be disconnected.
    A hold is a short pause and counts as on.
    """
    partnerAppsEnabled: Boolean!
  }

  extend type Query {
    "The signed-in climber's connected apps, in every PARTNER_OAUTH_MODE."
    myConnectedApps: ConnectedApps!
    """
    Whether partner apps are switched on (any PARTNER_OAUTH_MODE but off), the same
    value as ConnectedApps.partnerAppsEnabled. Screens that only need to know whether
    to mention connected apps read this. It changes only with a deploy.
    """
    partnerAppsEnabled: Boolean!
  }

  extend type Mutation {
    """
    End the signed-in climber's connection to an app, with the same effect as the
    app calling DELETE /v1/connection: every token and the remembered consent go,
    and connecting again needs a fresh approval. Works in every PARTNER_OAUTH_MODE,
    so a climber can always end a connection. True once the connection is ended,
    also when it already was. NOT_FOUND when the id is not one of the climber's
    connections.
    """
    disconnectApp(connectionId: ID!): Boolean!
  }
`;
