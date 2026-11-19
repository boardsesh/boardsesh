import { gql } from 'graphql-request';

export const RESOLVE_PARTNER_SESSION_HISTORY = gql`
  query ResolvePartnerSessionHistory($exportId: ID!) {
    resolvePartnerSessionHistory(exportId: $exportId)
  }
`;

export type ResolvePartnerSessionHistoryResponse = {
  resolvePartnerSessionHistory: string | null;
};
