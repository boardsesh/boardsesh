import { gql } from 'graphql-request';

export const CLIMB_STATS_FOR_ANGLES = gql`
  query ClimbStatsForAngles($boardName: String!, $climbUuid: ID!) {
    climbStatsForAngles(boardName: $boardName, climbUuid: $climbUuid) {
      angle
      ascensionistCount
      kilterAscensionistCount
      auroraAscensionistCount
      boardseshAscensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      difficulty
      faUsername
      faAt
    }
  }
`;

export type ClimbStatsForAnglesEntry = {
  angle: number;
  ascensionistCount: number | null;
  // Raw per-source counts; the client derives "Board app" = GREATEST(kilter, aurora).
  kilterAscensionistCount: number | null;
  auroraAscensionistCount: number | null;
  boardseshAscensionistCount: number | null;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  difficulty: string | null;
  faUsername: string | null;
  faAt: string | null;
};

export type ClimbStatsForAnglesResponse = {
  climbStatsForAngles: ClimbStatsForAnglesEntry[];
};
