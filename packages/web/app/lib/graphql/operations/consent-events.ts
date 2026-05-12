import { gql } from 'graphql-request';
import type { RecordConsentRejectionInput } from '@boardsesh/shared-schema';

export const RECORD_CONSENT_REJECTION = gql`
  mutation RecordConsentRejection($input: RecordConsentRejectionInput!) {
    recordConsentRejection(input: $input)
  }
`;

export type RecordConsentRejectionMutationVariables = {
  input: RecordConsentRejectionInput;
};

export type RecordConsentRejectionMutationResponse = {
  recordConsentRejection: boolean;
};

export type { RecordConsentRejectionInput, ConsentRejectionSource } from '@boardsesh/shared-schema';
