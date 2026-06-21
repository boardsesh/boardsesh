import { gql } from 'graphql-request';
import type {
  AttachBetaLinkInput,
  BetaLinksGqlRow,
  InstagramBetaScanInput,
  InstagramBetaScanResult,
} from '@boardsesh/shared-schema';

export type RecentBetaLinkGqlRow = {
  climbName: string | null;
  boardType: string;
  layoutId: number | null;
  betaLink: BetaLinksGqlRow;
};

export const GET_BETA_LINKS = gql`
  query GetBetaLinks($boardType: String!, $climbUuid: String!) {
    betaLinks(boardType: $boardType, climbUuid: $climbUuid) {
      climbUuid
      link
      foreignUsername
      angle
      thumbnail
      isListed
      createdAt
      tickUuid
      boardId
    }
  }
`;

export type GetBetaLinksQueryVariables = { boardType: string; climbUuid: string };
export type GetBetaLinksQueryResponse = { betaLinks: BetaLinksGqlRow[] };

export const ATTACH_BETA_LINK = gql`
  mutation AttachBetaLink($input: AttachBetaLinkInput!) {
    attachBetaLink(input: $input)
  }
`;

export type AttachBetaLinkMutationVariables = { input: AttachBetaLinkInput };
export type AttachBetaLinkMutationResponse = { attachBetaLink: boolean };

export const GET_RECENT_BETA_LINKS = gql`
  query GetRecentBetaLinks($limit: Int, $boardType: String) {
    recentBetaLinks(limit: $limit, boardType: $boardType) {
      climbName
      boardType
      layoutId
      betaLink {
        climbUuid
        link
        foreignUsername
        angle
        thumbnail
        isListed
        createdAt
        tickUuid
        boardId
      }
    }
  }
`;

export type GetRecentBetaLinksQueryVariables = {
  limit?: number;
  boardType?: string | null;
};

export type GetRecentBetaLinksQueryResponse = {
  recentBetaLinks: RecentBetaLinkGqlRow[];
};

export const GET_USER_BETA_LINKS = gql`
  query GetUserBetaLinks($userId: String!, $limit: Int, $offset: Int) {
    userBetaLinks(userId: $userId, limit: $limit, offset: $offset) {
      climbName
      boardType
      layoutId
      betaLink {
        climbUuid
        link
        foreignUsername
        angle
        thumbnail
        isListed
        createdAt
        tickUuid
        boardId
      }
    }
  }
`;

export type GetUserBetaLinksQueryVariables = {
  userId: string;
  limit?: number;
  offset?: number;
};

export type GetUserBetaLinksQueryResponse = {
  userBetaLinks: RecentBetaLinkGqlRow[];
};

export const BETA_LINK_PREVIEW = gql`
  query BetaLinkPreview($link: String!) {
    betaLinkPreview(link: $link) {
      link
      thumbnail
      username
      caption
    }
  }
`;

export type BetaLinkPreviewRow = {
  link: string;
  thumbnail: string | null;
  username: string | null;
  caption: string | null;
};

export type BetaLinkPreviewQueryVariables = { link: string };
export type BetaLinkPreviewQueryResponse = { betaLinkPreview: BetaLinkPreviewRow };

export const INSTAGRAM_BETA_SCAN = gql`
  query InstagramBetaScan($input: InstagramBetaScanInput!) {
    instagramBetaScan(input: $input) {
      scanned
      parsed
      missing {
        shortcode
        link
        climbUuid
        climbName
        boardType
        angle
      }
      alreadyLinked {
        shortcode
        link
        climbUuid
        climbName
        boardType
        angle
      }
      ambiguous {
        shortcode
        link
        parsedName
        boardType
        angle
        candidates {
          climbUuid
          name
          layoutId
          setterUsername
        }
      }
      unmatched {
        shortcode
        link
        parsedName
        reason
      }
    }
  }
`;

export type InstagramBetaScanQueryVariables = { input: InstagramBetaScanInput };
export type InstagramBetaScanQueryResponse = { instagramBetaScan: InstagramBetaScanResult };
