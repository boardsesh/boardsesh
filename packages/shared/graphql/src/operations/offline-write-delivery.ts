import { gql } from 'graphql-request';
import type {
  RecordOfflineWriteObservationsInput,
  RecordOfflineWriteObservationsResult,
} from '@boardsesh/shared-schema';

export const RECORD_OFFLINE_WRITE_OBSERVATIONS = gql`
  mutation RecordOfflineWriteObservations($input: RecordOfflineWriteObservationsInput!) {
    recordOfflineWriteObservations(input: $input) {
      receipts {
        deliveryId
        revision
        serverAcceptedAt
        serverRejectedAt
      }
    }
  }
`;

export type RecordOfflineWriteObservationsVariables = { input: RecordOfflineWriteObservationsInput };
export type RecordOfflineWriteObservationsResponse = {
  recordOfflineWriteObservations: RecordOfflineWriteObservationsResult;
};
