import { gql } from 'graphql-request';
import type { ClimbSearchInput, HoldStat } from '@boardsesh/shared-schema';

/**
 * Per-hold usage over the climbs a search matches. Admin-only on the server;
 * mobile registers it as a local-only offline operation, so a normal climber's
 * request is answered from the downloaded board and never reaches the network.
 */
export const HOLD_HEATMAP_QUERY = gql`
  query HoldHeatmap($input: ClimbSearchInput!) {
    holdHeatmap(input: $input) {
      holdId
      totalUses
      startingUses
      handUses
      footUses
      finishUses
      totalAscents
      averageDifficulty
    }
  }
`;

export type HoldHeatmapQueryVariables = { input: ClimbSearchInput };
export type HoldHeatmapQueryResponse = { holdHeatmap: HoldStat[] };
