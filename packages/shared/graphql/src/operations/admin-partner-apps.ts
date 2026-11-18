import { gql } from 'graphql-request';
import type {
  AdminPartnerApp,
  AdminPartnerAppConnection,
  AdminPartnerAppsInput,
  UpdatePartnerAppLimitsInput,
} from '@boardsesh/shared-schema';

const ADMIN_PARTNER_APP_FIELDS = `
  clientId name publisherName ownerUserId ownerName ownerEmail homepageUrl createdAt disabled suspendedAt suspensionReason
  activeConnections newConnectionsLast24Hours maxActiveConnections maxNewConnectionsPerDay
`;

export const ADMIN_PARTNER_APPS = gql`
  query AdminPartnerApps($input: AdminPartnerAppsInput) {
    adminPartnerApps(input: $input) {
      apps { ${ADMIN_PARTNER_APP_FIELDS} }
      totalCount
      hasMore
    }
  }
`;

export const UPDATE_PARTNER_APP_LIMITS = gql`
  mutation UpdatePartnerAppLimits($input: UpdatePartnerAppLimitsInput!) {
    updatePartnerAppLimits(input: $input) { ${ADMIN_PARTNER_APP_FIELDS} }
  }
`;

export type AdminPartnerAppsQueryVariables = { input?: AdminPartnerAppsInput };
export type AdminPartnerAppsQueryResponse = { adminPartnerApps: AdminPartnerAppConnection };
export type UpdatePartnerAppLimitsMutationVariables = { input: UpdatePartnerAppLimitsInput };
export type UpdatePartnerAppLimitsMutationResponse = { updatePartnerAppLimits: AdminPartnerApp };
