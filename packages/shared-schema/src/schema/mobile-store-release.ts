export const mobileStoreReleaseTypeDefs = /* GraphQL */ `
  enum MobileStorePlatform {
    ios
    android
  }

  type MobileStoreRelease {
    latestVersion: String!
    firstNewerMinorAvailableAt: String!
    checkedAt: String!
    storeUrl: String!
  }

  extend type Query {
    """
    Latest publicly available native release; null when no reliable newer minor release is known.
    """
    mobileStoreRelease(platform: MobileStorePlatform!, nativeVersion: String!): MobileStoreRelease
  }
`;
