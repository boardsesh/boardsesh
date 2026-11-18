import { gql } from 'graphql-request';
const SETTINGS = 'clientId url events enabled disabledReason previousSecretExpiresAt';
export const GET_PARTNER_WEBHOOK_SETTINGS = gql`
  query PartnerWebhookSettings($clientId: ID!) { partnerWebhookSettings(clientId: $clientId) { ${SETTINGS} } }
`;
export const GET_PARTNER_WEBHOOK_DELIVERIES = gql`
  query PartnerWebhookDeliveries($clientId: ID!) {
    partnerWebhookDeliveries(clientId: $clientId) {
      id
      event
      status
      attempts
      lastStatusCode
      lastError
      createdAt
      deliveredAt
    }
  }
`;
export const UPDATE_PARTNER_WEBHOOK = gql`
  mutation UpdatePartnerWebhook($input: UpdatePartnerWebhookInput!) { updatePartnerWebhook(input: $input) { settings { ${SETTINGS} } secret } }
`;
export const ROTATE_PARTNER_WEBHOOK_SECRET = gql`
  mutation RotatePartnerWebhookSecret($clientId: ID!) { rotatePartnerWebhookSecret(clientId: $clientId) { settings { ${SETTINGS} } secret } }
`;
export const TEST_PARTNER_WEBHOOK = gql`
  mutation TestPartnerWebhook($clientId: ID!) {
    testPartnerWebhook(clientId: $clientId)
  }
`;
