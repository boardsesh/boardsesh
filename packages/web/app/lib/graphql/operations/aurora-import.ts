import { gql } from 'graphql-request';

export const IMPORT_AURORA_JSON = gql`
  mutation ImportAuroraJson($input: AuroraImportInput!) {
    importAuroraJson(input: $input) {
      ascents {
        imported
        skipped
        failed
      }
      attempts {
        imported
        skipped
        failed
      }
      circuits {
        imported
        skipped
        failed
      }
      unresolvedClimbs
      claimedUsername
    }
  }
`;
