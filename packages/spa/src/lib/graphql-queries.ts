import { gql } from 'graphql-request'

/**
 * Resolve a board entity by its slug.
 */
export const BOARD_BY_SLUG = gql`
  query BoardBySlug($slug: String!) {
    boardBySlug(slug: $slug) {
      uuid
      slug
      ownerId
      boardType
      layoutId
      sizeId
      setIds
      name
      description
      locationName
      isPublic
      isOwned
      angle
      isAngleAdjustable
      layoutName
      sizeName
      sizeDescription
      setNames
    }
  }
`

/**
 * Search climbs with filtering, sorting, and pagination.
 */
export const SEARCH_CLIMBS = gql`
  query SearchClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        uuid
        name
        setter_username
        difficulty
        quality_average
        ascensionist_count
        frames
        angle
        stars
        difficulty_error
        litUpHoldsMap
        benchmark_difficulty
        userAscents
        userAttempts
      }
      totalCount
      hasMore
    }
  }
`

/**
 * Get full climb detail including lit-up holds.
 */
export const CLIMB_DETAIL = gql`
  query ClimbDetail(
    $boardName: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
    $angle: Int!
    $climbUuid: String!
  ) {
    climbDetail(
      boardName: $boardName
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      angle: $angle
      climbUuid: $climbUuid
    ) {
      uuid
      setter_username
      name
      description
      frames
      angle
      ascensionist_count
      difficulty
      quality_average
      difficulty_error
      benchmark_difficulty
      litUpHoldsMap
    }
  }
`

/**
 * Get climb stats for all angles.
 */
export const CLIMB_STATS = gql`
  query ClimbStats($boardName: String!, $climbUuid: String!) {
    climbStats(boardName: $boardName, climbUuid: $climbUuid) {
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      faUsername
      faAt
      difficulty
    }
  }
`

/**
 * Get beta (video) links for a climb.
 */
export const CLIMB_BETA_LINKS = gql`
  query ClimbBetaLinks($boardName: String!, $climbUuid: String!) {
    climbBetaLinks(boardName: $boardName, climbUuid: $climbUuid) {
      climbUuid
      link
      foreignUsername
      angle
      thumbnail
      isListed
      createdAt
    }
  }
`

/**
 * Get difficulty grades for a board type.
 */
export const GRADES = gql`
  query Grades($boardName: String!) {
    grades(boardName: $boardName) {
      difficultyId
      name
    }
  }
`
