import { gql } from 'graphql-request';
import type { HoldHeatmapInput, HoldStat } from '@boardsesh/shared-schema';

export const HOLD_HEATMAP_QUERY = gql`
  query HoldHeatmap($input: HoldHeatmapInput!) {
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

export type HoldHeatmapQueryVariables = { input: HoldHeatmapInput };
export type HoldHeatmapQueryResponse = { holdHeatmap: HoldStat[] };
