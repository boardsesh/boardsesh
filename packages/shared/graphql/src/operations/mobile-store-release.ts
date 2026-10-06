import { gql } from 'graphql-request';
import type { MobileStorePlatform, MobileStoreRelease } from '@boardsesh/shared-schema/mobile-store-release';

export const MOBILE_STORE_RELEASE = gql`
  query MobileStoreRelease($platform: MobileStorePlatform!, $nativeVersion: String!) {
    mobileStoreRelease(platform: $platform, nativeVersion: $nativeVersion) {
      latestVersion
      firstNewerMinorAvailableAt
      checkedAt
      storeUrl
    }
  }
`;

export type MobileStoreReleaseQueryVariables = {
  platform: MobileStorePlatform;
  nativeVersion: string;
};

export type MobileStoreReleaseQueryResponse = {
  mobileStoreRelease: MobileStoreRelease | null;
};
